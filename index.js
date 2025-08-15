require("dotenv").config();
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const axios = require('axios');
const multer = require('multer');
const FormData = require('form-data');
const sharp = require('sharp');
const { exec } = require('child_process');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const TelegramBot = require('node-telegram-bot-api');
const { SpeechClient } = require('@google-cloud/speech');
const { ImageAnnotatorClient } = require('@google-cloud/vision').v1;

// ================== تهيئة التطبيق ==================
const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '50mb' }));

// ================== تهيئة العملاء ==================
const bot = new TelegramBot(process.env.TEL_TOKEN, { polling: false });
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const speechClient = new SpeechClient({
  credentials: {
    client_email: process.env.GOOGLE_CLIENT_EMAIL,
    private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    project_id: process.env.GOOGLE_PROJECT_ID
  }
});

const visionClient = new ImageAnnotatorClient({
  credentials: {
    client_email: process.env.GOOGLE_CLIENT_EMAIL,
    private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    project_id: process.env.GOOGLE_PROJECT_ID
  }
});

// ================== جلسات المحادثة ==================
const textSessions = {};
const voiceSessions = {};

// ================== نقاط النهاية ==================

// 1. تحويل الصوت إلى صوت
app.post('/api/speech-to-voice', async (req, res) => {
  try {
    const { audio, voiceId = '9BWtsMINqrJLrRacOk9x', sessionId = 'default' } = req.body;

    if (!audio) {
      return res.status(400).json({ error: 'لم يتم تقديم بيانات صوتية' });
    }

    // تحويل الصوت إلى نص
    const [speechResponse] = await speechClient.recognize({
      audio: { content: audio },
      config: {
        encoding: 'OGG_OPUS',
        sampleRateHertz: 48000,
        languageCode: 'ar-SA',
      }
    });

    const transcription = speechResponse.results
      .map(result => result.alternatives[0]?.transcript || '')
      .join('\n')
      .trim();

    if (!transcription) {
      throw new Error('لم يتم التعرف على أي نص في الصوت');
    }

    // توليد الرد باستخدام Gemini
    if (!voiceSessions[sessionId]) voiceSessions[sessionId] = [];
    voiceSessions[sessionId].push({ role: 'user', parts: [{ text: transcription }] });

    const model = genAI.getGenerativeModel({ model: "gemini-1.5-pro" });
    const result = await model.generateContent({ contents: voiceSessions[sessionId] });
    const reply = result.response.text();

    voiceSessions[sessionId].push({ role: 'model', parts: [{ text: reply }] });

    // تحويل النص إلى صوت
    const ttsResponse = await axios.post(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
      {
        text: reply,
        voice_settings: { stability: 0.5, similarity_boost: 0.5 }
      },
      {
        headers: {
          'xi-api-key': process.env.ELEVENLABS_KEY,
          'Content-Type': 'application/json',
          'accept': 'audio/mpeg'
        },
        responseType: 'arraybuffer'
      }
    );

    res.set('Content-Type', 'audio/mpeg');
    res.send(ttsResponse.data);

  } catch (error) {
    console.error('Error in speech-to-voice:', error);
    res.status(500).json({
      error: 'حدث خطأ أثناء معالجة الصوت',
      details: error.message
    });
  }
});

// 2. نقطة النهاية الذكية للدردشة
const upload = multer({ storage: multer.memoryStorage() });

app.post('/chat', upload.single('image'), async (req, res) => {
  try {
    const { message, sessionId = 'default' } = req.body;
    const imageFile = req.file;

    if (!message && !imageFile) {
      return res.status(400).json({ error: "يجب إرسال نص أو صورة" });
    }

    // معالجة الصور إذا وجدت
    if (imageFile) {
      if (message.includes('إزالة خلفية') || message.includes('remove background')) {
        const form = new FormData();
        form.append('image_file', imageFile.buffer, { filename: 'image.png' });
        
        const removeBgResponse = await axios.post('https://api.remove.bg/v1.0/removebg', form, {
          headers: { ...form.getHeaders(), 'X-Api-Key': process.env.REMOVEBG_KEY },
          responseType: 'arraybuffer',
        });

        return res.json({
          action: 'remove-bg',
          image: removeBgResponse.data.toString('base64'),
          message: "تمت إزالة الخلفية بنجاح"
        });
      }
      else {
        // معالجة الصورة باستخدام Google Vision
        const [visionResult] = await visionClient.annotateImage({
          image: { content: imageFile.buffer },
          features: [{ type: 'TEXT_DETECTION' }]
        });

        const detectedText = visionResult.fullTextAnnotation?.text || 'لم يتم التعرف على نص';
        const fullMessage = `${message}\n\nالنص في الصورة:\n${detectedText}`;

        if (!textSessions[sessionId]) textSessions[sessionId] = [];
        textSessions[sessionId].push({ role: 'user', parts: [{ text: fullMessage }] });

        const model = genAI.getGenerativeModel({ model: "gemini-1.5-pro" });
        const result = await model.generateContent({ contents: textSessions[sessionId] });
        const reply = result.response.text();

        textSessions[sessionId].push({ role: 'model', parts: [{ text: reply }] });

        return res.json({ reply });
      }
    }

    // معالجة النص فقط
    if (!textSessions[sessionId]) textSessions[sessionId] = [];
    textSessions[sessionId].push({ role: 'user', parts: [{ text: message }] });

    const model = genAI.getGenerativeModel({ model: "gemini-1.5-pro" });
    const result = await model.generateContent({ contents: textSessions[sessionId] });
    const reply = result.response.text();

    textSessions[sessionId].push({ role: 'model', parts: [{ text: reply }] });

    res.json({ reply });

  } catch (error) {
    console.error('Error in chat endpoint:', error);
    res.status(500).json({ error: "حدث خطأ أثناء معالجة الطلب" });
  }
});

// ================== Telegram Webhook ==================
const WEBHOOK_URL = `https://keytele.onrender.com/webhook`;
bot.setWebHook(WEBHOOK_URL);

app.post('/webhook', (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// ================== معالجة رسائل Telegram ==================
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  
  try {
    // رسالة صوتية
    if (msg.voice) {
      const fileId = msg.voice.file_id;
      const fileLink = await bot.getFileLink(fileId);
      const response = await axios.get(fileLink, { responseType: 'arraybuffer' });
      
      const audioBase64 = Buffer.from(response.data).toString('base64');
      
      const apiResponse = await axios.post(
        `https://keytele.onrender.com/api/speech-to-voice`,
        { audio: audioBase64, sessionId: chatId.toString() },
        { responseType: 'arraybuffer' }
      );
      
      await bot.sendVoice(chatId, Buffer.from(apiResponse.data));
    }
    // صورة مع أو بدون نص
    else if (msg.photo) {
      const fileId = msg.photo[msg.photo.length-1].file_id;
      const fileLink = await bot.getFileLink(fileId);
      const response = await axios.get(fileLink, { responseType: 'arraybuffer' });

      const formData = new FormData();
      formData.append('image', response.data, { filename: 'photo.jpg' });
      formData.append('message', msg.caption || '');
      formData.append('sessionId', chatId.toString());

      const apiResponse = await axios.post(
        `https://keytele.onrender.com/chat`,
        formData,
        { headers: formData.getHeaders() }
      );

      if (apiResponse.data.image) {
        await bot.sendPhoto(chatId, Buffer.from(apiResponse.data.image, 'base64'));
      }
      if (apiResponse.data.reply) {
        await bot.sendMessage(chatId, apiResponse.data.reply);
      }
    }
    // رسالة نصية
    else if (msg.text) {
      const apiResponse = await axios.post(`https://keytele.onrender.com/chat`, {
        message: msg.text,
        sessionId: chatId.toString()
      });

      await bot.sendMessage(chatId, apiResponse.data.reply);
    }
  } catch (error) {
    console.error('Telegram error:', error);
    await bot.sendMessage(chatId, 'حدث خطأ أثناء معالجة رسالتك، يرجى المحاولة لاحقاً.');
  }
});

// ================== تشغيل السيرفر ==================
const PORT = process.env.PORT || 8000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📞 Telegram webhook: ${WEBHOOK_URL}`);
});
