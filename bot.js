require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const pdfParse = require("pdf-parse");
const fetch = require("node-fetch");

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });

let userData = {};

// START
bot.onText(/\/start/, (msg) => {
    bot.sendMessage(msg.chat.id,
        "👋 Welcome to ATS Resume Analyzer Bot!\n\n" +
        "📄 Send your Resume (PDF)\n" +
        "📌 Then send Job Description"
    );
});

// HANDLE PDF
bot.on("document", async (msg) => {
    const chatId = msg.chat.id;

    try {
        const fileId = msg.document.file_id;
        const file = await bot.getFile(fileId);

        const url = `https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${file.file_path}`;

        const res = await fetch(url);
        const buffer = await res.buffer();

        const data = await pdfParse(buffer);

        userData[chatId] = {
            resume: data.text
        };

        bot.sendMessage(chatId, "✅ Resume received! Now send Job Description.");

    } catch (err) {
        console.log(err);
        bot.sendMessage(chatId, "❌ Error reading PDF.");
    }
});

// HANDLE JD
bot.on("message", (msg) => {
    const chatId = msg.chat.id;

    if (!msg.text || msg.text.startsWith("/")) return;

    if (!userData[chatId]?.resume) {
        bot.sendMessage(chatId, "⚠️ Please upload resume first.");
        return;
    }

    userData[chatId].jd = msg.text;

    const score = calculateATS(
        userData[chatId].resume,
        userData[chatId].jd
    );

    bot.sendMessage(chatId, `📊 ATS Score: ${score}/100`);
});

// ATS LOGIC
function calculateATS(resume, jd) {
    const resumeWords = resume.toLowerCase().split(/\W+/);
    const jdWords = jd.toLowerCase().split(/\W+/);

    let matchCount = 0;

    jdWords.forEach(word => {
        if (resumeWords.includes(word)) {
            matchCount++;
        }
    });

    const score = (matchCount / jdWords.length) * 100;
    return Math.round(score);
}