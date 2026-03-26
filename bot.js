require("dotenv").config();

const TelegramBot = require("node-telegram-bot-api");
const pdfModule = require("pdf-parse");
const mammoth = require("mammoth");
const fetch = require("node-fetch");
const fs = require("fs");
const os = require("os");
const path = require("path");

if (!process.env.BOT_TOKEN) {
    throw new Error("BOT_TOKEN is missing in .env");
}

const LOCK_FILE = path.join(os.tmpdir(), "ats_telegram_bot.lock");
ensureSingleInstance();

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });

bot.on("polling_error", (err) => {
    if (err && err.code === "ETELEGRAM" && String(err.message || "").includes("409")) {
        console.error("Another bot instance is running. Stop duplicate process and restart this bot.");
        return;
    }
    console.error("Polling error:", err.message || err);
});

let userData = {};
const SCORE_THRESHOLD = 65;
const STOP_WORDS = new Set([
    "and", "the", "for", "with", "you", "your", "from", "that", "this", "have", "will", "are", "our", "job", "role",
    "ability", "skills", "years", "year", "experience", "candidate", "work", "team", "using", "must", "should", "can"
]);

bot.onText(/\/start/, (msg) => {
    bot.sendMessage(
        msg.chat.id,
        "👋 Welcome to ATS Resume Analyzer Bot!\n\n" +
        "📄 Step 1: Send your Resume (PDF, DOCX, or TXT)\n" +
        "📌 Step 2: Send Job Description as text\n\n" +
        "I will return ATS score, missing keywords, and improvements."
    );
});

bot.on("document", async (msg) => {
    const chatId = msg.chat.id;

    try {
        const fileId = msg.document.file_id;
        const fileName = (msg.document.file_name || "").toLowerCase();

        if (!fileName.endsWith(".pdf") && !fileName.endsWith(".docx") && !fileName.endsWith(".txt")) {
            bot.sendMessage(chatId, "⚠️ Please upload PDF, DOCX, or TXT file.");
            return;
        }

        const file = await bot.getFile(fileId);
        const url = `https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${file.file_path}`;

        const res = await fetch(url);
        if (!res.ok) {
            throw new Error(`Telegram file download failed: ${res.status}`);
        }
        const buffer = await res.buffer();

        let text = "";

        if (fileName.endsWith(".pdf")) {
            text = await extractPdfText(buffer);
        } else if (fileName.endsWith(".docx")) {
            const result = await mammoth.extractRawText({ buffer });
            text = result.value;
        } else {
            text = buffer.toString("utf-8");
        }

        if (!text || !text.trim()) {
            bot.sendMessage(chatId, "⚠️ Could not extract text from file. Try another resume file.");
            return;
        }

        userData[chatId] = {
            resume: text
        };

        bot.sendMessage(chatId, "✅ Resume received. Now send the Job Description as plain text.");

    } catch (err) {
        console.error("Resume processing error:", err.message);
        bot.sendMessage(chatId, "❌ Error reading resume file. Please try again.");
    }
});

bot.on("message", (msg) => {
    const chatId = msg.chat.id;

    if (!msg.text || msg.text.startsWith("/")) return;

    if (!userData[chatId]?.resume) {
        bot.sendMessage(chatId, "⚠️ Please upload resume first.");
        return;
    }

    const jd = msg.text;
    const resume = userData[chatId].resume;

    const ats = evaluateATS(resume, jd);
    const suggestionText = getRecommendations(ats.score, ats.missingKeywords);

    bot.sendMessage(
        chatId,
        `📊 ATS Score: ${ats.score}/100\n\n` +
        `✅ Matched Keywords: ${ats.matchedKeywords.length}\n` +
        `❗ Missing Keywords:\n${ats.missingKeywords.slice(0, 12).join(", ") || "None"}\n\n` +
        suggestionText
    );

    sendImprovedCvFiles(chatId, resume, jd, ats).catch((err) => {
        console.error("CV generation error:", err.message);
    });

    // Reset state so user can run a new analysis cleanly.
    delete userData[chatId];
});

function normalizeWords(text) {
    return text
        .toLowerCase()
        .split(/[^a-z0-9+#.]+/)
        .filter((w) => w.length > 2 && !STOP_WORDS.has(w));
}

function evaluateATS(resume, jd) {
    const resumeSet = new Set(normalizeWords(resume));
    const jdSet = new Set(normalizeWords(jd));
    const jdKeywords = [...jdSet];

    if (!jdKeywords.length) {
        return {
            score: 0,
            matchedKeywords: [],
            missingKeywords: []
        };
    }

    const matchedKeywords = jdKeywords.filter((word) => resumeSet.has(word));
    const missingKeywords = jdKeywords.filter((word) => !resumeSet.has(word));

    return {
        score: Math.round((matchedKeywords.length / jdKeywords.length) * 100),
        matchedKeywords,
        missingKeywords
    };
}

function getRecommendations(score, missingKeywords) {
    if (score >= SCORE_THRESHOLD) {
        return "🎯 Strong match! Improve further by adding measurable achievements and role-specific keywords.";
    }

    const topMissing = missingKeywords.slice(0, 8).join(", ") || "No major keywords detected";
    return (
        "🛠 Score is below target. Improve your resume by:\n" +
        "1) Adding missing keywords in skills/projects sections\n" +
        "2) Rewriting bullets with action + impact metrics\n" +
        "3) Aligning summary line with JD responsibilities\n\n" +
        `Suggested keywords to include: ${topMissing}`
    );
}

function buildImprovedCvText(resume, jd, ats) {
    const improvements = [
        "Improved ATS CV Draft",
        "",
        "Summary:",
        "Result-driven candidate aligned with the role requirements. Add quantifiable outcomes per project/experience.",
        "",
        "Top Missing JD Keywords:",
        ...(ats.missingKeywords.slice(0, 15).length ? ats.missingKeywords.slice(0, 15) : ["No major missing keyword found"]),
        "",
        "Bullet Rewrite Template:",
        "- Action verb + task + tool/skill + measurable impact (%, $, time saved, users impacted)",
        "",
        "JD Snapshot:",
        jd.slice(0, 1200),
        "",
        "Original Resume Snapshot:",
        resume.slice(0, 1800)
    ];

    return improvements.join("\n");
}

async function sendImprovedCvFiles(chatId, resume, jd, ats) {
    const content = buildImprovedCvText(resume, jd, ats);
    const stamp = Date.now();
    const txtPath = path.join(os.tmpdir(), `improved_cv_${chatId}_${stamp}.txt`);
    const mdPath = path.join(os.tmpdir(), `improved_cv_${chatId}_${stamp}.md`);

    fs.writeFileSync(txtPath, content, "utf-8");
    fs.writeFileSync(mdPath, `# Improved CV Draft\n\n${content}`, "utf-8");

    await bot.sendDocument(chatId, txtPath, {
        caption: "📥 Download improved CV (TXT format)"
    });

    await bot.sendDocument(chatId, mdPath, {
        caption: "📥 Download improved CV (Markdown format)"
    });

    fs.unlinkSync(txtPath);
    fs.unlinkSync(mdPath);
}

async function extractPdfText(buffer) {
    // pdf-parse v1: function(buffer) -> { text }
    if (typeof pdfModule === "function") {
        const result = await pdfModule(buffer);
        return result?.text || "";
    }

    // pdf-parse v2: { PDFParse } class
    if (pdfModule && typeof pdfModule.PDFParse === "function") {
        const parser = new pdfModule.PDFParse({ data: buffer });
        try {
            const result = await parser.getText();
            return result?.text || "";
        } finally {
            await parser.destroy();
        }
    }

    throw new Error("Unsupported pdf-parse export. Install pdf-parse@1.1.1 or use a compatible version.");
}

function ensureSingleInstance() {
    try {
        if (fs.existsSync(LOCK_FILE)) {
            const pid = Number(fs.readFileSync(LOCK_FILE, "utf-8"));
            if (pid && pid !== process.pid && isProcessAlive(pid)) {
                throw new Error(`Another bot instance is running with PID ${pid}.`);
            }
        }

        fs.writeFileSync(LOCK_FILE, String(process.pid), "utf-8");

        const cleanup = () => {
            try {
                if (fs.existsSync(LOCK_FILE)) {
                    const lockPid = Number(fs.readFileSync(LOCK_FILE, "utf-8"));
                    if (lockPid === process.pid) {
                        fs.unlinkSync(LOCK_FILE);
                    }
                }
            } catch (_) {
                // Ignore cleanup failures.
            }
        };

        process.on("exit", cleanup);
        process.on("SIGINT", () => {
            cleanup();
            process.exit(0);
        });
        process.on("SIGTERM", () => {
            cleanup();
            process.exit(0);
        });
    } catch (err) {
        console.error(err.message || err);
        process.exit(1);
    }
}

function isProcessAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch (_) {
        return false;
    }
}