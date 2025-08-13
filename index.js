





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
const token=process.env.TEL_TOKEN;
const bot = new TelegramBot(token, { polling: true });

const app = express();
app.use(cors());
app.use(bodyParser.urlencoded({ extended: false }));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100
});
app.use(limiter);

const upload = multer({ storage: multer.memoryStorage() });

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// --- دالة تنفيذ الأوامر (promise) ---
function execAsync(command) {
  return new Promise((resolve, reject) => {
    exec(command, (error, stdout, stderr) => {
      if (error) return reject(error);
      resolve({ stdout, stderr });
    });
  });
}

// --- API: الحصول على معلومات الفيديو ---
const ytDlpPath = `"C:\\Users\\Computer\\AppData\\Roaming\\Python\\Python312\\Scripts\\yt-dlp.exe"`;
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


// --- معالجة الصور: التحقق والضبط ---
const validateImage = async (req, res, next) => {
  if (!req.file) return res.status(400).json({ error: 'لم يتم تحميل أي ملف', solution: 'يجب اختيار صورة JPG, PNG, WEBP' });

  try {
    const imageBuffer = req.file.buffer || fs.readFileSync(req.file.path);
    const metadata = await sharp(imageBuffer).metadata();
    if (!['jpeg', 'png', 'webp'].includes(metadata.format)) {
      return res.status(400).json({ error: 'نوع الملف غير مدعوم', detectedFormat: metadata.format, allowedFormats: ['JPEG', 'PNG', 'WEBP'] });
    }
    req.imageBuffer = imageBuffer;
    req.imageMetadata = metadata;
    next();
  } catch {
    return res.status(400).json({ error: 'ملف غير صالح', details: 'الملف تالف أو ليس صورة' });
  }
};

const processImage = async (imageBuffer) => {
  const targetWidth = 1024, targetHeight = 1024;
  const processedImage = await sharp(imageBuffer)
    .resize({ width: targetWidth, height: targetHeight, fit: 'cover', position: 'center', withoutEnlargement: false })
    .png({ quality: 90, compressionLevel: 6 })
    .toBuffer();

  return processedImage.toString('base64');
};

// --- API: تعديل الصورة باستخدام Stability AI ---

app.post('/api/edit-image', upload.single('image'), validateImage, async (req, res) => {
  console.log('dd');
  try {
    const { prompt } = req.body;
    if (!prompt || prompt.trim().length < 5) {
      return res.status(400).json({
        error: 'وصف غير صالح',
        solution: 'الوصف يجب أن يحتوي على 5 أحرف على الأقل'
      });
    }

    // تجهيز الصورة كملف حقيقي (Buffer) وليس نص Base64
    const processedImageBuffer = await sharp(req.imageBuffer)
      .resize({ width: 1024, height: 1024, fit: 'cover' })
      .png()
      .toBuffer();

    const formData = new FormData();
    formData.append('init_image', processedImageBuffer, {
      filename: 'image.png',
      contentType: 'image/png'
    });
    formData.append('text_prompts[0][text]', prompt);
    formData.append('cfg_scale', 7);
    formData.append('steps', 50);

    const response = await axios.post(
      'https://api.stability.ai/v1/generation/stable-diffusion-xl-1024-v1-0/image-to-image',
      formData,
      {
        headers: {
          Authorization: `Bearer ${process.env.STABILITY_API_KEY}`,
          ...formData.getHeaders()
        },
        maxBodyLength: Infinity
      }
    );

    if (!response.data.artifacts?.length) {
      return res.status(500).json({
        error: 'لا توجد صور مسترجعة من API',
        solution: 'حاول مع وصف مختلف'
      });
    }

    res.json({
      success: true,
      imageBase64: response.data.artifacts[0].base64,
      promptUsed: prompt,
      generatedAt: new Date().toISOString()
    });
} catch (error) {
  console.error("===== Stability AI Error =====");
  console.error("Status:", error.response?.status);
  console.error("Data:", error.response?.data);
  console.error("Headers:", error.response?.headers);
  console.error("Config:", {
    url: error.config?.url,
    method: error.config?.method,
    headers: error.config?.headers,
  });
  console.error("==============================");

  res.status(error.response?.status || 500).json({
    error: 'خطأ في المعالجة',
    details: error.response?.data || error.message
  });
}
});

// --- API: إزالة الخلفية باستخدام remove.bg ---
const uploadMemory = multer({ storage: multer.memoryStorage() });
app.post('/remove-bg', uploadMemory.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).send('No image uploaded');
  try {
    const form = new FormData();
    form.append('image_file', req.file.buffer, req.file.originalname);
    form.append('size', 'auto');

    const response = await axios.post('https://api.remove.bg/v1.0/removebg', form, {
      headers: {
        ...form.getHeaders(),
        'X-Api-Key': process.env.REMOVEBG_KEY,
      },
      responseType: 'arraybuffer',
    });

    res.set('Content-Type', 'image/png');
    res.send(response.data);
  } catch (error) {
    res.status(500).send('Failed to remove background');
  }
});

// --- API: كشف النص في الصورة ---
const { ImageAnnotatorClient } = require('@google-cloud/vision').v1;
const client2 = new ImageAnnotatorClient({
  keyFilename: JSON.parse(process.env.GOOGLE_CREDENTIALS)
});
app.post('/detect-text', upload.single('image'), async (req, res) => {

  if (!req.file) return res.status(400).send('No image uploaded');
  try {
    const [result] = await client2.textDetection(req.file.buffer);
    const detections = result.textAnnotations;
    const text = detections[0]?.description || "";
    res.json({ text });
  } catch {
    res.status(500).send('Failed to detect text');
  }
});

// --- API: كشف تسميات الصورة ---
app.post('/detect-labels', upload.single('image'), async (req, res) => {
  
  if (!req.file) return res.status(400).send('No image uploaded');
  try {
    const [result] = await client2.labelDetection(req.file.buffer);
    const labels = result.labelAnnotations;
    res.json({ labels });
  } catch {
    res.status(500).send('Failed to detect labels');
  }
});

// --- دالة تحديد نوع الطلب باستخدام LLM Gemini ---
async function decideTool(text, hasImage) {
  const prompt = `
حدد نوع الطلب من التالي بناءً على النص ووجود صورة:
- remove-bg (إذا طلب إزالة خلفية وكانت هناك صورة)
- edit-image (إذا طلب تعديل الصورة وكانت هناك صورة) 
- chat (إذا كان طلبًا نصيًا عاديًا)

النص: "${text}"
هل يوجد صورة: ${hasImage ? 'نعم' : 'لا'}
النوع:
  `;

  try {
    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-pro-latest' });
    const response = await model.generateContent({
      contents: [{ role: 'user', parts: [{ text: prompt }] }]
    });

    const tool = response.response.text().trim().toLowerCase();
    if (tool.includes('remove-bg') || tool.includes('remove background')) return 'remove-bg';
    if (tool.includes('edit-image') || tool.includes('edit image')) return 'edit-image';
    return 'chat';

  } catch (error) {
    console.error('خطأ في تحديد الأداة:', error);
    return 'chat';
  }
}

function escapeMarkdown(text) {
  // تهرب الرموز الخاصة بـ MarkdownV2
  if (!text) return '';
  return text.replace(/([_*[\]()~`>#+-=|{}.!])/g, '\\$1');
}

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

      const response = await axios.post('https://keytele.onrender.com/chat2', formData, { headers: formData.getHeaders() });
      clearInterval(typingInterval);

      if (response.data.action === 'edit-image' || response.data.action === 'remove-bg') {
        await bot.sendPhoto(chatId, Buffer.from(response.data.imageBase64, 'base64'), { filename: 'image.png', contentType: 'image/png' });
      } else if (response.data.reply) {
        await bot.sendMessage(chatId, response.data.reply);
      }

    } else if (msg.text) {
      const response = await axios.post('https://keytele.onrender.com/chat2', { message: msg.text, sessionId: chatId.toString() });
      clearInterval(typingInterval);

      if (response.data.reply) await bot.sendMessage(chatId, response.data.reply);
    }

  } catch (err) {
    console.error('Telegram bot error:', err);
    await bot.sendMessage(chatId, 'حدث خطأ أثناء المعالجة، حاول لاحقاً.');
  }
});




// --- نقطة النهاية الموحدة الذكية: /chat2 ---
const sessions = {};
const upload4 = multer({ storage: multer.memoryStorage() });

app.post('/chat2', upload4.single('image'), async (req, res) => {
  try {
    const { message, sessionId } = req.body;
    const imageFile = req.file;

    console.log('Received request:', {
      headers: req.headers,
      body: req.body,
      file: !!imageFile
    });

    if (!sessionId) return res.status(400).json({ error: "Session ID is required" });
    if (!message || message.trim().length === 0) return res.status(400).json({ error: "Message text is required" });

    const action = await decideTool(message, !!imageFile);

    if (action === 'remove-bg' && imageFile) {
      // حذف الخلفية
      const form = new FormData();
      form.append('image_file', imageFile.buffer, { filename: imageFile.originalname });
      const removeBgResponse = await axios.post('https://api.remove.bg/v1.0/removebg', form, {
        headers: { ...form.getHeaders(), 'X-Api-Key': process.env.REMOVEBG_KEY },
        responseType: 'arraybuffer',
      });

      return res.json({
        action: 'remove-bg',
        imageBase64: removeBgResponse.data.toString('base64'),
        message: "Background removed successfully"
      });

    } else if (action === 'edit-image' && imageFile) {
      // إعادة تحجيم الصورة مع الحفاظ على المحتوى الكامل
      const processedBuffer = await sharp(imageFile.buffer)
        .resize({
          width: 1024,
          height: 1024,
          fit: 'contain',
          background: { r: 255, g: 255, b: 255 } // يمكن تغييره حسب الحاجة
        })
        .png()
        .toBuffer();

      // تجهيز formData للـ Stability AI
      const formData = new FormData();
      formData.append('init_image', processedBuffer, { filename: 'image.png', contentType: 'image/png' });
      formData.append('text_prompts[0][text]', message);
      formData.append('cfg_scale', 7);
      formData.append('clip_guidance_preset', 'FAST_BLUE');
      formData.append('steps', 30);

      const response = await axios.post(
        'https://api.stability.ai/v1/generation/stable-diffusion-xl-1024-v1-0/image-to-image',
        formData,
        {
          headers: {
            Authorization: `Bearer ${process.env.STABILITY_API_KEY}`,
            Accept: 'application/json',
            ...formData.getHeaders()
          },
          maxBodyLength: Infinity
        }
      );

      return res.json({
        action: 'edit-image',
        imageBase64: response.data.artifacts[0].base64,
        message: "Image edited successfully"
      });

    } else {
      // دردشة نصية
      if (!sessions[sessionId]) sessions[sessionId] = [];
      sessions[sessionId].push({ role: 'user', parts: [{ text: message }] });

      const model = genAI.getGenerativeModel({ model: 'gemini-1.5-pro-latest' });
      const result = await model.generateContent({ contents: sessions[sessionId] });
      const reply = result.response.text();
      sessions[sessionId].push({ role: 'model', parts: [{ text: reply }] });

      return res.json({ action: 'chat', reply });
    }

  } catch (error) {
    console.error("Error processing request:", error);
    console.error("Status:", error.response?.status);
    console.error("Data:", error.response?.data);
    console.error("Headers:", error.response?.headers);

    return res.status(500).json({ error: "Internal server error" });
  }
});


// --- تشغيل السيرفر ---
app.listen(8000, () => {
  console.log('🚀 Server running on http://localhost:8000');
});



