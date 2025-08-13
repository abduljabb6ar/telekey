










require("dotenv").config();
const express = require('express');
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
const { ImageAnnotatorClient } = require('@google-cloud/vision').v1;

// ================== Telegram Setup ==================
const token = process.env.TEL_TOKEN;
const bot = new TelegramBot(token, { polling: false }); // Webhook mode

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

// 📌 Google Vision
const visionClient = new ImageAnnotatorClient({
  keyFilename: JSON.parse(process.env.GOOGLE_CREDENTIALS)
});

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

// --- API: تعديل الصورة باستخدام Stability AI ---
app.post('/edit-image', upload.single('image'), async (req, res) => {
  try {
    const { prompt } = req.body;
    if (!req.file) return res.status(400).json({ error: 'No image uploaded' });
    if (!prompt || prompt.trim().length < 5) return res.status(400).json({ error: 'Prompt too short' });

    const processedBuffer = await sharp(req.file.buffer)
      .resize({ width: 1024, height: 1024, fit: 'cover' })
      .png()
      .toBuffer();

    const formData = new FormData();
    formData.append('init_image', processedBuffer, { filename: 'image.png', contentType: 'image/png' });
    formData.append('text_prompts[0][text]', prompt);
    formData.append('cfg_scale', 7);
    formData.append('steps', 30);

    const response = await axios.post(
      'https://api.stability.ai/v1/generation/stable-diffusion-xl-1024-v1-0/image-to-image',
      formData,
      { headers: { Authorization: `Bearer ${process.env.STABILITY_API_KEY}`, ...formData.getHeaders() }, maxBodyLength: Infinity }
    );

    res.json({ success: true, imageBase64: response.data.artifacts[0].base64 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- API: إزالة الخلفية ---
app.post('/remove-bg', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No image uploaded' });
    const form = new FormData();
    form.append('image_file', req.file.buffer, { filename: req.file.originalname });
    form.append('size', 'auto');

    const response = await axios.post('https://api.remove.bg/v1.0/removebg', form, {
      headers: { ...form.getHeaders(), 'X-Api-Key': process.env.REMOVEBG_KEY },
      responseType: 'arraybuffer',
    });

    res.set('Content-Type', 'image/png');
    res.send(response.data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- API: كشف النص ---
app.post('/detect-text', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No image uploaded' });
    const [result] = await visionClient.textDetection(req.file.buffer);
    const text = result.textAnnotations[0]?.description || '';
    res.json({ text });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- API: كشف تسميات الصورة ---
app.post('/detect-labels', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No image uploaded' });
    const [result] = await visionClient.labelDetection(req.file.buffer);
    const labels = result.labelAnnotations.map(l => l.description);
    res.json({ labels });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- API: نقطة النهاية الذكية /chat2 ---
const sessions = {};
app.post('/chat2', upload.single('image'), async (req, res) => {
  try {
    const { message, sessionId } = req.body;
    if (!sessionId || !message) return res.status(400).json({ error: 'sessionId & message required' });

    const hasImage = !!req.file;
    let action = 'chat';

    // تحديد الأداة
    const promptTool = `
حدد نوع الطلب بناء على النص ووجود صورة:
النص: "${message}"
هل يوجد صورة: ${hasImage ? 'نعم' : 'لا'}
النوع:
`;
    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-pro-latest' });
    const toolResp = await model.generateContent({ contents: [{ role: 'user', parts: [{ text: promptTool }] }] });
    const tool = toolResp.response.text().toLowerCase();
    if ((tool.includes('remove-bg') || tool.includes('remove background')) && hasImage) action = 'remove-bg';
    else if ((tool.includes('edit-image') || tool.includes('edit image')) && hasImage) action = 'edit-image';

    if (action === 'remove-bg') {
      const form = new FormData();
      form.append('image_file', req.file.buffer, { filename: req.file.originalname });
      const removeResp = await axios.post('https://api.remove.bg/v1.0/removebg', form, {
        headers: { ...form.getHeaders(), 'X-Api-Key': process.env.REMOVEBG_KEY },
        responseType: 'arraybuffer',
      });
      return res.json({ action, imageBase64: removeResp.data.toString('base64') });
    }

    if (action === 'edit-image') {
      const processedBuffer = await sharp(req.file.buffer)
        .resize({ width: 1024, height: 1024, fit: 'contain', background: { r: 255, g: 255, b: 255 } })
        .png()
        .toBuffer();

      const formData = new FormData();
      formData.append('init_image', processedBuffer, { filename: 'image.png', contentType: 'image/png' });
      formData.append('text_prompts[0][text]', message);
      formData.append('cfg_scale', 7);
      formData.append('steps', 30);

      const response = await axios.post(
        'https://api.stability.ai/v1/generation/stable-diffusion-xl-1024-v1-0/image-to-image',
        formData,
        { headers: { Authorization: `Bearer ${process.env.STABILITY_API_KEY}`, ...formData.getHeaders() }, maxBodyLength: Infinity }
      );
      return res.json({ action, imageBase64: response.data.artifacts[0].base64 });
    }

    // دردشة نصية
    if (!sessions[sessionId]) sessions[sessionId] = [];
    sessions[sessionId].push({ role: 'user', parts: [{ text: message }] });
    const result = await model.generateContent({ contents: sessions[sessionId] });
    const reply = result.response.text();
    sessions[sessionId].push({ role: 'model', parts: [{ text: reply }] });

    res.json({ action: 'chat', reply });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ================== Telegram Webhook ==================
const WEBHOOK_URL = `https://keytele.onrender.com/webhook/${token}`;
bot.setWebHook(WEBHOOK_URL);

app.post(`/webhook/${token}`, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;

  const welcomeMessage = `
مرحباً بك في بوت *KV* .. 🤖

هذا البوت يوفر لك مجموعة من الأدوات الذكية:

1️⃣ **تنزيل الفيديوهات والصوتيات**
   - احصل على معلومات الفيديو من أي رابط ..
   - تحميل الفيديو أو الصوت بجودات متعددة ..

2️⃣ **تحرير الصور**
   - تعديل الصور باستخدام الذكاء الاصطناعي ..
   - إزالة الخلفية بسهولة ..

3️⃣ **تحليل الصور**
   - كشف النصوص داخل الصور ..
   - التعرف على تسميات الأشياء داخل الصورة ..

4️⃣ **دردشة ذكية**
   - يمكنك التحدث مع البوت مباشرة ..
   - البوت قادر على فهم أوامر تعديل  الصور أو إزالة الخلفية تلقائياً إذا أرسلت صورة مع نص ..

📌 *طريقة الاستخدام:*
- أرسل رابط الفيديو لتحصل على معلوماته وتحميله ..
- أرسل صورة مع نص لتعديل الصورة أو إزالة الخلفية ..
- أرسل أي رسالة نصية لتحدث مع البوت ..

استمتع بالتجربة ..! 🚀

💡 مطور البوت: [mrkey7](https://t.me/mrkey7)
`;

  await bot.sendMessage(chatId, welcomeMessage, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: '🔗 تواصل مع المطور',
            url: 'https://t.me/mrkey7'
          }
        ]
      ]
    }
  });
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

      const response = await axios.post(`https://keytele.onrender.com/chat2`, formData, { headers: formData.getHeaders() });
      clearInterval(typingInterval);

      if (response.data.action === 'edit-image' || response.data.action === 'remove-bg') {
        await bot.sendPhoto(chatId, Buffer.from(response.data.imageBase64, 'base64'));
      } else if (response.data.reply) {
        await bot.sendMessage(chatId, response.data.reply);
      }

    } else if (msg.text) {
      const response = await axios.post(`https://keytele.onrender.com/chat2`, { message: msg.text, sessionId: chatId.toString() });
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
