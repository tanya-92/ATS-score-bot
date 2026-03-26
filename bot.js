require("dotenv").config();

const TelegramBot = require("node-telegram-bot-api");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const pdfModule = require("pdf-parse");
const mammoth = require("mammoth");
const fetch = require("node-fetch");
const fs = require("fs");
const os = require("os");
const path = require("path");

if (!process.env.BOT_TOKEN) {
    throw new Error("BOT_TOKEN is missing in .env");
}

let model = null;
let genAIClient = null;
const FALLBACK_MODELS = ["gemini-2.5-flash", "gemini-2.5-pro"];
if (process.env.GEMINI_API_KEY) {
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    genAIClient = genAI;
    const modelName = process.env.GEMINI_MODEL || "gemini-2.5-flash";
    model = genAI.getGenerativeModel({
        model: modelName
    });
} else {
    console.warn("GEMINI_API_KEY is missing. AI suggestions and AI resume rewrite are disabled.");
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
let aiUsage = {};
const SCORE_THRESHOLD = 65;
const STOP_WORDS = new Set([
    "and", "the", "for", "with", "you", "your", "from", "that", "this", "have", "will", "are", "our", "job", "role",
    "ability", "skills", "years", "year", "experience", "candidate", "work", "team", "using", "must", "should", "can"
]);
const BAD_KEYWORDS = new Set([
    "eligibility", "students", "student", "university", "college", "undergraduate", "postgraduate", "recognized", "open", "any",
    "front", "development", "creating", "visually", "appealing", "interactive", "responsive", "interfaces", "like", "server"
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

bot.on("message", async (msg) => {
    const chatId = msg.chat.id;

    if (!msg.text || msg.text.startsWith("/")) return;

    const textMsg = msg.text.trim();
    const textLen = textMsg.length;

    const isConversational = textLen < 150 && (textLen < 50 || /^(hi|hello|hey|can you|how|what|why|help|thanks|thank you)\b/i.test(textMsg) || textMsg.endsWith("?"));

    if (isConversational) {
        if (model) {
            try {
                const prompt = `You are a helpful ATS Resume Assistant Bot. The user sent a conversational message: "${textMsg}". ` +
                    (userData[chatId]?.resume
                        ? `The user's current uploaded resume is provided below. Reply conversationally, keeping your answer short.\nResume: ${userData[chatId].resume.slice(0, 1500)}`
                        : "Remind them they can start by uploading a PDF/DOCX/TXT resume.");
                const fb = await generateWithFallback(prompt);
                bot.sendMessage(chatId, fb.text());
                return;
            } catch (e) {
                console.error("Chat failure", e);
            }
        }
    }

    if (!userData[chatId]?.resume) {
        bot.sendMessage(chatId, "⚠️ Please upload your resume first (PDF/DOCX/TXT) before ATS processing.");
        return;
    }

    const jd = textMsg;
    if (jd.length < 30) {
        bot.sendMessage(chatId, "⚠️ Please provide a detailed job description (at least 30 characters).");
        return;
    }

    const resume = userData[chatId].resume;

    let ats;
    let usedAI = false;

    if (model) {
        const usage = aiUsage[chatId];
        const today = new Date().toDateString();
        if (!usage || usage.date !== today) {
            aiUsage[chatId] = { count: 0, date: today };
        }

        if (aiUsage[chatId].count < 3) {
            try {
                ats = await generateAIAtsScore(resume, jd);
                usedAI = true;
                aiUsage[chatId].count++;
            } catch (err) {
                console.error("AI ATS Scoring failed:", err.message || err);
                usedAI = false;
            }
        }
    }

    if (!usedAI) {
        ats = evaluateATS(resume, jd);
    }

    const suggestionText = getRecommendations(ats.score, ats.missingKeywords);
    const missingStyled = ats.missingKeywords.slice(0, 12).map((k) => `- ${k} ❌`).join("\n") || "None";

    await bot.sendMessage(
        chatId,
        `📊 ATS Score: ${ats.score}/100\n\n` +
        `📌 Score Breakdown\n` +
        `Skills Match: ${ats.breakdown.skillsMatch}%\n` +
        `Experience Match: ${ats.breakdown.experienceMatch}%\n` +
        `Keywords Match: ${ats.breakdown.keywordsMatch}%\n\n` +
        `✅ Matched Keywords: ${ats.matchedKeywords.length}\n` +
        `❗ Missing Keywords:\n${missingStyled}\n\n` +
        suggestionText
    );

    const top3 = ats.missingKeywords.slice(0, 3);
    await bot.sendMessage(
        chatId,
        `🔥 Top Fixes:\n` +
        `1. Add ${top3[0] || "relevant skills"}\n` +
        `2. Improve ${top3[1] || "project bullets"}\n` +
        `3. Highlight ${top3[2] || "tools used"}`
    );

    try {
        if (!model) {
            await sendImprovedCvFiles(chatId, resume, jd, ats);
            delete userData[chatId];
            return;
        }

        if (aiUsage[chatId].count >= 3 && !usedAI) {
            await bot.sendMessage(chatId, "⚠️ AI limit reached (3 uses/day).");
            await sendImprovedCvFiles(chatId, resume, jd, ats);
            delete userData[chatId];
            return;
        }

        if (!usedAI) {
            await sendImprovedCvFiles(chatId, resume, jd, ats);
            delete userData[chatId];
            return;
        }

        const aiSuggestions = await generateAISuggestions(
            resume,
            jd,
            ats.missingKeywords
        );

        await bot.sendMessage(
            chatId,
            `🤖 AI Suggestions:\n\n${aiSuggestions}`
        );

        const aiResume = await generateAIResume(resume, jd);

        const filePath = path.join(os.tmpdir(), `ai_cv_${chatId}_${Date.now()}.txt`);
        fs.writeFileSync(filePath, aiResume, "utf-8");

        await bot.sendDocument(
            chatId,
            filePath,
            { caption: "🤖 AI Optimized Resume (Text)" },
            { filename: path.basename(filePath), contentType: "text/plain" }
        );

        const util = require("util");
        const exec = util.promisify(require("child_process").exec);

        try {
            // General format
            const { stdout: out1 } = await exec(`python update_docx.py "cv/generalcv.docx" "${filePath}"`);
            const docPath1 = out1.trim().split("\\n").pop();
            if (fs.existsSync(docPath1)) {
                await bot.sendDocument(
                    chatId,
                    docPath1,
                    { caption: "📝 General CV (ATS Optimized)" },
                    { filename: path.basename(docPath1), contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }
                );
                fs.unlinkSync(docPath1);
            }

            // Specialized format
            const { stdout: out2 } = await exec(`python update_docx.py "cv/specialized.docx" "${filePath}"`);
            const docPath2 = out2.trim().split("\\n").pop();
            if (fs.existsSync(docPath2)) {
                await bot.sendDocument(
                    chatId,
                    docPath2,
                    { caption: "💼 Specialized CV (ATS Optimized)" },
                    { filename: path.basename(docPath2), contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }
                );
                fs.unlinkSync(docPath2);
            }
        } catch (docxErr) {
            console.error("DOCX Gen Error:", docxErr.message || docxErr);
        }

        fs.unlinkSync(filePath);
    } catch (err) {
        console.error("AI ERROR:", err.message || err);
        await sendImprovedCvFiles(chatId, resume, jd, ats);
    }

    // Reset state so user can run a new analysis cleanly.
    delete userData[chatId];
});

function normalizeWords(text) {
    return text
        .toLowerCase()
        .split(/[^a-z0-9+#.]+/)
        .filter(isGoodKeyword);
}

function isGoodKeyword(word) {
    return (
        word.length > 3 &&
        !/^\d+$/.test(word) &&
        !STOP_WORDS.has(word) &&
        !BAD_KEYWORDS.has(word)
    );
}

function evaluateATS(resume, jd) {
    const sections = extractResumeSections(resume);
    const resumeSet = new Set(normalizeWords(resume));
    const jdSet = new Set(normalizeWords(jd));
    const jdKeywords = [...jdSet];

    if (!jdKeywords.length) {
        return {
            score: 0,
            matchedKeywords: [],
            missingKeywords: [],
            breakdown: {
                skillsMatch: 0,
                experienceMatch: 0,
                keywordsMatch: 0
            }
        };
    }

    const matchedKeywords = jdKeywords.filter((word) => isMatch(word, resumeSet));
    const missingKeywords = jdKeywords.filter((word) => !isMatch(word, resumeSet));

    const skillsWords = new Set(normalizeWords(sections.skills));
    const experienceWords = new Set(normalizeWords(`${sections.experience}\n${sections.projects}`));
    const skillsMatched = jdKeywords.filter((word) => isMatch(word, skillsWords)).length;
    const experienceMatched = jdKeywords.filter((word) => isMatch(word, experienceWords)).length;

    const keywordsMatch = Math.round((matchedKeywords.length / jdKeywords.length) * 100);
    const skillsMatch = Math.round((skillsMatched / jdKeywords.length) * 100);
    const experienceMatch = Math.round((experienceMatched / jdKeywords.length) * 100);

    const rawScore = Math.round((keywordsMatch * 0.5) + (skillsMatch * 0.25) + (experienceMatch * 0.25));

    return {
        score: rawScore < 20 ? rawScore : Math.max(rawScore, 30),
        matchedKeywords,
        missingKeywords,
        breakdown: {
            skillsMatch,
            experienceMatch,
            keywordsMatch
        }
    };
}

function isMatch(word, resumeWords) {
    return [...resumeWords].some((rw) => rw.includes(word) || word.includes(rw));
}

function extractSkills(text) {
    const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    return lines.filter((line) => /\b(skill|skills|tech stack|technologies)\b/i.test(line));
}

function extractResumeSections(text) {
    const lines = text.split(/\r?\n/);
    const sections = {
        skills: extractSkills(text).join("\n"),
        experience: "",
        projects: ""
    };

    let current = "";
    for (const raw of lines) {
        const line = raw.trim();
        const lower = line.toLowerCase();

        if (/\b(skills|technical skills|tech stack|technologies)\b/.test(lower)) {
            current = "skills";
            continue;
        }
        if (/\b(experience|work experience|employment|internship)\b/.test(lower)) {
            current = "experience";
            continue;
        }
        if (/\b(projects|project experience|academic projects)\b/.test(lower)) {
            current = "projects";
            continue;
        }

        if (current && line) {
            sections[current] += `${line}\n`;
        }
    }

    if (!sections.experience) {
        sections.experience = text;
    }
    if (!sections.projects) {
        sections.projects = text;
    }

    return sections;
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
    return rewriteResumeDraft(resume, jd, ats);
}

async function generateAIAtsScore(resume, jd) {
    const trimmedResume = resume.slice(0, 4000);
    const trimmedJD = jd.slice(0, 2000);

    const prompt = `
You are an ATS resume expert. Evaluate the following resume against the job description.
Return a RAW JSON object representing the ATS score and keyword match data.
DO NOT use markdown formatting (no \`\`\`json). Just return the raw JSON string.
The JSON must have EXACTLY this structure:
{
  "score": <number between 0 and 100>,
  "matchedKeywords": [<string array of up to 10 matched skills>],
  "missingKeywords": [<string array of up to 10 missing skills from JD>],
  "breakdown": {
    "skillsMatch": <number 0-100>,
    "experienceMatch": <number 0-100>,
    "keywordsMatch": <number 0-100>
  }
}

Resume:
${trimmedResume}

Job Description:
${trimmedJD}
`;
    const response = await generateWithFallback(prompt);
    let text = response.text().trim();
    if (text.startsWith("\`\`\`json")) text = text.replace(/^\`\`\`json[\s\n]*/i, "");
    if (text.startsWith("\`\`\`")) text = text.replace(/^\`\`\`[\s\n]*/, "");
    if (text.endsWith("\`\`\`")) text = text.replace(/[\s\n]*\`\`\`$/i, "");
    const parsed = JSON.parse(text);
    if (typeof parsed.score !== "number") throw new Error("Invalid ATS JSON");
    return parsed;
}

async function generateAISuggestions(resume, jd, missingKeywords) {
    const trimmedResume = resume.slice(0, 4000);
    const trimmedJD = jd.slice(0, 2000);

    const prompt = `
You are an ATS resume expert.

Analyze the resume vs job description and give concise actionable advice:
1. Key improvements
2. Missing skills to add
3. Bullet improvement suggestions

Missing Keywords:
${missingKeywords.join(", ")}

Resume:
${trimmedResume}

Job Description:
${trimmedJD}

CRITICAL RULES:
- Use PLAIN TEXT ONLY. DO NOT use any markdown characters (like **, _, ###, #).
- Use clear visual emojis (like 📌, 💡, ✅, 🛠) for bullet points and section headers.
- Keep the response brief, highly practical, and strictly under 150 words.
`;

    const response = await generateWithFallback(prompt);

    let text = response.text() || "";
    // Clean up any rogue markdown just in case the AI hallucinates it
    text = text.replace(/[*_#`~]+/g, "");

    return text.trim();
}

async function generateAIResume(resume, jd) {
    const trimmedResume = resume.slice(0, 4000);
    const trimmedJD = jd.slice(0, 2000);

    const prompt = `
Rewrite this resume to match the job description.

Rules:
- ATS optimized
- Strong action verbs
- Add relevant skills
- Keep professional formatting

Resume:
${trimmedResume}

Job Description:
${trimmedJD}
`;

    const response = await generateWithFallback(prompt);

    return response.text();
}

async function generateWithFallback(prompt) {
    if (model) {
        try {
            const result = await model.generateContent(prompt);
            return result.response;
        } catch (err) {
            const message = String(err.message || err);
            if (!message.includes("404") || !genAIClient) {
                throw err;
            }
        }
    }

    if (!genAIClient) {
        throw new Error("Gemini client is not initialized.");
    }

    for (const modelName of FALLBACK_MODELS) {
        try {
            const fallback = genAIClient.getGenerativeModel({ model: modelName });
            const result = await fallback.generateContent(prompt);
            model = fallback;
            return result.response;
        } catch (_) {
            // Try next model.
        }
    }

    throw new Error("No compatible Gemini model available for generateContent.");
}

function rewriteResumeDraft(resume, jd, ats) {
    const sections = extractResumeSections(resume);
    const lines = resume
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);

    const possibleName = lines[0] && lines[0].length < 60 ? lines[0] : "Candidate Name";
    const roleKeywords = [...ats.matchedKeywords, ...ats.missingKeywords].slice(0, 10);
    const topSkills = roleKeywords.slice(0, 8);

    const bulletsFromResume = [...sections.experience.split(/\r?\n/), ...sections.projects.split(/\r?\n/)]
        .filter((line) => /^[\-•*]/.test(line) || /\b(developed|built|managed|designed|implemented|created|led)\b/i.test(line))
        .slice(0, 8);

    const fallbackBullets = resume
        .split(/[.!?]\s+/)
        .map((s) => s.trim())
        .filter((s) => s.length > 35)
        .slice(0, 6)
        .map((s) => `- ${s}`);

    const sourceBullets = bulletsFromResume.length ? bulletsFromResume : fallbackBullets;
    const actionVerbs = ["Delivered", "Engineered", "Optimized", "Implemented", "Collaborated", "Automated", "Improved", "Designed"];

    const rewrittenBullets = sourceBullets.slice(0, 6).map((bullet, idx) => {
        const clean = bullet.replace(/^[\-•*]\s*/, "").trim();
        const k1 = roleKeywords[idx % Math.max(roleKeywords.length, 1)] || "role-specific tools";
        const k2 = roleKeywords[(idx + 1) % Math.max(roleKeywords.length, 1)] || "business requirements";
        const verb = actionVerbs[idx % actionVerbs.length];
        const low = clean.charAt(0).toLowerCase() + clean.slice(1);
        const templates = [
            `${verb} ${low} resulting in improved efficiency.`,
            `${verb} ${low} using ${k1}, enhancing performance.`,
            `${verb} ${low}, contributing to team success with focus on ${k2}.`
        ];
        return `- ${templates[idx % templates.length]}`;
    });

    const jdSnapshot = jd
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(0, 6)
        .join("\n");

    return [
        `${possibleName}`,
        "Email | Phone | LinkedIn | GitHub",
        "",
        "PROFESSIONAL SUMMARY",
        `Results-oriented professional with hands-on experience aligned to ${roleKeywords.slice(0, 4).join(", ") || "target role requirements"}. Demonstrated ability to execute projects, collaborate with teams, and deliver measurable outcomes in fast-paced environments.`,
        "",
        "CORE SKILLS",
        topSkills.length ? topSkills.join(" | ") : "Project Execution | Communication | Problem Solving | Time Management",
        "",
        "PROFESSIONAL EXPERIENCE",
        ...rewrittenBullets,
        "",
        "ATS ALIGNMENT NOTES",
        `Current ATS score: ${ats.score}/100`,
        `High-priority missing keywords: ${ats.missingKeywords.slice(0, 10).join(", ") || "None"}`,
        "",
        "TARGET JD SNAPSHOT",
        jdSnapshot || "No JD snapshot available"
    ].join("\n");
}

async function sendImprovedCvFiles(chatId, resume, jd, ats) {
    const content = buildImprovedCvText(resume, jd, ats);
    const stamp = Date.now();
    const txtPath = path.join(os.tmpdir(), `improved_cv_${chatId}_${stamp}.txt`);
    const mdPath = path.join(os.tmpdir(), `improved_cv_${chatId}_${stamp}.md`);

    fs.writeFileSync(txtPath, content, "utf-8");
    fs.writeFileSync(mdPath, `# Improved CV Draft\n\n${content}`, "utf-8");

    await bot.sendDocument(
        chatId,
        txtPath,
        {
            caption: "📥 Download improved CV (TXT format)"
        },
        {
            filename: path.basename(txtPath),
            contentType: "text/plain"
        }
    );

    await bot.sendDocument(
        chatId,
        mdPath,
        {
            caption: "📥 Download improved CV (Markdown format)"
        },
        {
            filename: path.basename(mdPath),
            contentType: "text/plain"
        }
    );

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