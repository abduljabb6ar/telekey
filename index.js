require("dotenv").config();
var express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const axios = require('axios');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const FormData = require('form-data');
const sharp = require('sharp');
const { exec } = require('child_process');
const https = require('https');
const http = require('http');
const url = require('url');
const rateLimit = require('express-rate-limit');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const TelegramBot = require('node-telegram-bot-api');

// ================== Telegram Setup ==================
const token = process.env.TEL_TOKEN;
const bot = new TelegramBot(token, { polling: false }); // ✅ Webhook mode

const app = express();
app.use(cors());
app.use(bodyParser.urlencoded({ extended: false }));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// 📌 Rate Limit
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100
});
app.use(limiter);

// 📌 Multer
const upload = multer({ storage: multer.memoryStorage() });

// 📌 Google Generative AI
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// 📌 Helper: تنفيذ أوامر
function execAsync(command) {
  return new Promise((resolve, reject) => {
    exec(command, (error, stdout, stderr) => {
      if (error) return reject(error);
      resolve({ stdout, stderr });
    });
  });
}

// ================== APIs ==================
const ytDlpPath = `"C:\\Users\\Computer\\AppData\\Roaming\\Python\\Python312\\Scripts\\yt-dlp.exe"`;

// --- API: الحصول على معلومات الفيديو ---
app.post('/api/get-video-info', async (req, res) => {
  const { videoUrl } = req.body;
  if (!videoUrl) return res.status(400).json({ success: false, error: 'videoUrl is required' });

  try {
    const videoCommand = `${ytDlpPath} -j --format "(bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best)" "${videoUrl}"`;
    const { stdout: videoStdout } = await execAsync(videoCommand);
    const videoInfo = JSON.parse(videoStdout);

    const audioCommand = `${ytDlpPath} -j --format "bestaudio" --extract-audio --audio-format mp3 "${videoUrl}"`;
    const { stdout: audioStdout } = await execAsync(audioCommand);
    const audioInfo = JSON.parse(audioStdout);

    const processFormats = (formats, type) => {
      return formats
        .filter(f => type === 'video' ? f.ext === 'mp4' : f.ext === 'mp3')
        .map(f => ({
          quality: type === 'video' ? (f.height ? `${f.height}p` : f.format_note || 'Default') : (f.abr ? `${f.abr}kbps` : 'Audio'),
          url: f.url,
          filesize: f.filesize,
          ext: f.ext,
          height: f.height || 0,
          bitrate: f.tbr || f.abr || 0
        }))
        .sort((a, b) => type === 'video' ? a.height - b.height : a.bitrate - b.bitrate);
    };

    res.json({
      success: true,
      data: {
        id: videoInfo.id,
        title: videoInfo.title,
        thumbnail: videoInfo.thumbnail,
        duration: videoInfo.duration,
        uploader: videoInfo.uploader,
        view_count: videoInfo.view_count,
        formats: processFormats(videoInfo.formats || [], 'video'),
        audio_formats: processFormats([audioInfo], 'audio'),
        webpage_url: videoInfo.webpage_url || videoUrl
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to process video info' });
  }
});

// --- API: تنزيل فيديو أو صوت ---
app.get('/api/download', async (req, res) => {
  try {
    const { url: mediaUrl, title, ext, type = 'video' } = req.query;
    if (!mediaUrl) return res.status(400).json({ error: 'Missing media URL' });

    const safeTitle = (title || 'media').replace(/[^a-zA-Z0-9_\-.]/g, '_').substring(0, 100);
    const fileExt = ext || (type === 'audio' ? 'mp3' : 'mp4');
    const filename = `${safeTitle}.${fileExt}`;

    if (mediaUrl.includes('.m3u8')) {
      const tempFile = path.join(__dirname, 'temp', filename);
      await execAsync(`${ytDlpPath} -o ${tempFile} --remux-video ${fileExt} "${mediaUrl}"`);
      return res.download(tempFile, filename, (err) => {
        if (err) console.error('Download error:', err);
        fs.unlinkSync(tempFile);
      });
    }

    const parsedUrl = url.parse(mediaUrl);
    const client = parsedUrl.protocol === 'https:' ? https : http;
    client.get(mediaUrl, (streamRes) => {
      if (streamRes.statusCode !== 200) return res.status(streamRes.statusCode).json({ error: 'Failed to fetch media' });

      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('Content-Type', type === 'audio' ? 'audio/mpeg' : 'video/mp4');
      res.setHeader('Content-Length', streamRes.headers['content-length'] || '');

      streamRes.pipe(res);
    }).on('error', (err) => {
      res.status(500).json({ error: 'Download failed' });
    });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// باقي الـ APIs: edit-image, remove-bg, detect-text, detect-labels, chat2
// انسخهم من كودك القديم كما هي تماماً هنا

// ================== Telegram Webhook ==================
const WEBHOOK_URL = `https://your-app-name.onrender.com/webhook/${token}`; // ⚠️ غيّر your-app-name
bot.setWebHook(WEBHOOK_URL);

app.post(`/webhook/${token}`, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// ================== Telegram Message Handling ==================
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const keepTyping = (chatId, interval = 4000) =>
    setInterval(() => bot.sendChatAction(chatId, 'typing').catch(console.error), interval);

  try {
    let typingInterval = keepTyping(chatId);

    if (msg.photo) {
      const fileId = msg.photo[msg.photo.length - 1].file_id;
      const fileLink = await bot.getFileLink(fileId);
      const axiosResponse = await axios.get(fileLink, { responseType: 'arraybuffer' });

      const formData = new FormData();
      formData.append('image', Buffer.from(axiosResponse.data), { filename: 'image.png', contentType: 'image/png' });
      formData.append('message', msg.caption || '');
      formData.append('sessionId', chatId.toString());

      const response = await axios.post(`https://your-app-name.onrender.com/chat2`, formData, { headers: formData.getHeaders() });
      clearInterval(typingInterval);

      if (response.data.action === 'edit-image' || response.data.action === 'remove-bg') {
        await bot.sendPhoto(chatId, Buffer.from(response.data.imageBase64, 'base64'), { filename: 'image.png', contentType: 'image/png' });
      } else if (response.data.reply) {
        await bot.sendMessage(chatId, response.data.reply);
      }

    } else if (msg.text) {
      const response = await axios.post(`https://your-app-name.onrender.com/chat2`, { message: msg.text, sessionId: chatId.toString() });
      clearInterval(typingInterval);

      if (response.data.reply) await bot.sendMessage(chatId, response.data.reply);
    }

  } catch (err) {
    console.error('Telegram bot error:', err);
    await bot.sendMessage(chatId, 'حدث خطأ أثناء المعالجة، حاول لاحقاً.');
  }
});

// ================== Server Listen ==================
const PORT = process.env.PORT || 8000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
