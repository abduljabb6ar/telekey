

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
const limiter = rateLimit({ windowMs: 15*60*1000, max: 100 });
app.use(limiter);

// 📌 Multer
const upload = multer({ storage: multer.memoryStorage() });

// 📌 Google Generative AI
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// 📌 Google Vision
const visionClient = new ImageAnnotatorClient({ keyFilename: JSON.parse(process.env.GOOGLE_CREDENTIALS) });

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
        .filter(f => type==='video'? f.ext==='mp4': f.ext==='mp3')
        .map(f=>({
          quality: type==='video'? (f.height?`${f.height}p`:f.format_note||'Default'): (f.abr?`${f.abr}kbps`:'Audio'),
          url: f.url, filesize: f.filesize, ext: f.ext, height: f.height||0, bitrate: f.tbr||f.abr||0
        }))
        .sort((a,b)=> type==='video'? a.height-b.height : a.bitrate-b.bitrate);
    };

    res.json({
      success:true,
      data:{
        id: videoInfo.id,
        title: videoInfo.title,
        thumbnail: videoInfo.thumbnail,
        duration: videoInfo.duration,
        uploader: videoInfo.uploader,
        view_count: videoInfo.view_count,
        formats: processFormats(videoInfo.formats||[], 'video'),
        audio_formats: processFormats([audioInfo], 'audio'),
        webpage_url: videoInfo.webpage_url||videoUrl
      }
    });

  } catch (error) {
    res.status(500).json({ success:false, error:'Failed to process video info' });
  }
});

// --- API: تنزيل فيديو أو صوت ---
app.get('/api/download', async (req,res)=>{
  try{
    const { url: mediaUrl, title, ext, type='video' } = req.query;
    if(!mediaUrl) return res.status(400).json({ error:'Missing media URL' });

    const safeTitle = (title||'media').replace(/[^a-zA-Z0-9_\-.]/g,'_').substring(0,100);
    const fileExt = ext||(type==='audio'?'mp3':'mp4');
    const filename = `${safeTitle}.${fileExt}`;

    const parsedUrl = url.parse(mediaUrl);
    const client = parsedUrl.protocol==='https:'? https : http;
    client.get(mediaUrl,(streamRes)=>{
      if(streamRes.statusCode!==200) return res.status(streamRes.statusCode).json({ error:'Failed to fetch media' });
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('Content-Type', type==='audio'?'audio/mpeg':'video/mp4');
      res.setHeader('Content-Length', streamRes.headers['content-length']||'');
      streamRes.pipe(res);
    }).on('error',(err)=> res.status(500).json({ error:'Download failed' }));
  } catch(err){ res.status(500).json({ error:'Server error' }); }
});

// --- API: نقطة النهاية الذكية /chat2 ---

  
// --- دالة تحديد نوع الطلب باستخدام LLM Gemini ---
async function decideTool(text, hasImage) {
const prompt = `
حدد نوع الطلب من التالي بناءً على النص ووجود صورة:

remove-bg (إذا طلب إزالة خلفية وكانت هناك صورة)

edit-image (إذا طلب تعديل الصورة وكانت هناك صورة)

chat (إذا كان طلبًا نصيًا عاديًا)

النص: "${text}"
هل يوجد صورة: ${hasImage ? 'نعم' : 'لا'}
النوع:
`;

try {
const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash-lite' });
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

const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash-lite' });
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


// ================== Telegram Webhook ==================
const WEBHOOK_URL = `https://keytele.onrender.com/webhook/${token}`;
bot.setWebHook(WEBHOOK_URL);

app.post(`/webhook/${token}`, (req,res)=>{
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// ================== Telegram Start Command ==================
bot.onText(/\/start/, async (msg)=>{
  const chatId = msg.chat.id;
  const welcomeMessage = `
مرحباً بك في بوت *KV* .. 🤖

هذا البوت يوفر لك مجموعة من الأدوات الذكية:

1️⃣ **تحرير الصور**
   - تعديل الصور باستخدام الذكاء الاصطناعي ..
   - إزالة الخلفية بسهولة 

4️⃣ **دردشة ذكية**
   - يمكنك التحدث مع البوت مباشرة ..
   - البوت قادر على فهم أوامر تعديل الصور أو إزالة الخلفية تلقائياً إذا أرسلت صورة مع نص ..

📌 *طريقة الاستخدام:*
- أرسل صورة مع نص لتعديل الصورة أو إزالة الخلفية ..
- أرسل أي رسالة نصية لتحدث مع البوت ..


🟨 * ملاحظة :*
   - البوت قيد التطوير سيتم اضافة الكثير من اليمزات سيتم دمج متجر الكتروني ذكي ..

استمتع بالتجربة ..! 🚀

💡 مطور البوت: [mrkey7](https://t.me/mrkey7)
`;

  await bot.sendMessage(chatId, welcomeMessage,{
    parse_mode:'Markdown',
    reply_markup:{ inline_keyboard:[[{ text:'🔗 تواصل مع المطور', url:'https://t.me/mrkey7' }]] }
  });
});
// ================== Telegram Message Handling مع إشعارات منظمة ==================
bot.on('message', async (msg)=>{
  const chatId = msg.chat.id;
  const username = msg.from.username || `${msg.from.first_name || ''} ${msg.from.last_name || ''}`.trim() || 'Unknown';
  const keepTyping = (chatId, interval=4000)=> setInterval(()=> bot.sendChatAction(chatId,'typing').catch(console.error), interval);

  try{
    let typingInterval = keepTyping(chatId);

    // ------------------- Notify Admin -------------------
    const adminChatId = process.env.ADMIN_CHAT_ID; // ضع هنا رقم شاتك في تلجرام
    if(adminChatId){
      const userMessage = msg.text || (msg.caption ? msg.caption : '[صورة]');
      const notifyText = `📨 *رسالة جديدة من المستخدم*\n\n👤 *اسم المستخدم:* @${username}\n💬 *الرسالة:* ${userMessage}`;
      await bot.sendMessage(adminChatId, notifyText, { parse_mode:'Markdown' }).catch(console.error);
    }
    // ---------------------------------------------------

    // ------------------- معالجة الرسائل -------------------
    if(msg.photo){
      const fileId = msg.photo[msg.photo.length-1].file_id;
      const fileLink = await bot.getFileLink(fileId);
      const axiosResponse = await axios.get(fileLink, { responseType:'arraybuffer' });

      const formData = new FormData();
      formData.append('image', Buffer.from(axiosResponse.data), { filename:'image.png', contentType:'image/png' });
      formData.append('message', msg.caption||'');
      formData.append('sessionId', chatId.toString());

      const response = await axios.post(`https://keytele.onrender.com/chat2`, formData, { headers: formData.getHeaders() });
      clearInterval(typingInterval);

      if(response.data.action==='edit-image'||response.data.action==='remove-bg'){
        await bot.sendPhoto(chatId, Buffer.from(response.data.imageBase64,'base64'));
      } else if(response.data.reply){
        await bot.sendMessage(chatId, response.data.reply);
      }

    } else if(msg.text){
      const response = await axios.post(`https://keytele.onrender.com/chat2`, { message: msg.text, sessionId: chatId.toString() });
      clearInterval(typingInterval);
      if(response.data.reply) await bot.sendMessage(chatId,response.data.reply);
    }
    // ---------------------------------------------------

  }catch(err){
    console.error('Telegram bot error:', err);
    await bot.sendMessage(chatId,'حدث خطأ أثناء المعالجة، حاول لاحقاً.');
  }
});
// ================== Telegram Message Handling ==================
//bot.on('message', async (msg)=>{
//  const chatId = msg.chat.id;
//  const keepTyping = (chatId, interval=4000)=> setInterval(()=> bot.sendChatAction(chatId,'typing').catch(console.error), interval);

//  try
//    let typingInterval = keepTyping(chatId);

//    if(msg.photo){
 //     const fileId = msg.photo[msg.photo.length-1].file_id;
//      const fileLink = await bot.getFileLink(fileId);
//const axiosResponse = await axios.get(fileLink, { responseType:'arraybuffer' });

  //    const formData = new FormData();
  //    formData.append('image', Buffer.from(axiosResponse.data), { filename:'image.png', contentType:'image/png' });
 //     formData.append('message', msg.caption||'');
  //    formData.append('sessionId', chatId.toString());

  //    const response = await axios.post(`https://keytele.onrender.com/chat2`, formData, { headers: formData.getHeaders() });
 //     clearInterval(typingInterval);

 //     if(response.data.action==='edit-image'||response.data.action==='remove-bg'){
 //       await bot.sendPhoto(chatId, Buffer.from(response.data.imageBase64,'base64'));
  //    }else if(response.data.reply){
 //       await bot.sendMessage(chatId, response.data.reply);
 //     }

 //   }else if(msg.text){
 //     const response = await axios.post(`https://keytele.onrender.com/chat2`, { message:msg.text, sessionId:chatId.toString() });
  //    clearInterval(typingInterval);
  //    if(response.data.reply) await bot.sendMessage(chatId,response.data.reply);
 //   }

//  }catch(err){
 //   console.error('Telegram bot error:', err);
 //   await bot.sendMessage(chatId,'حدث خطأ أثناء المعالجة، حاول لاحقاً.');

// ================== Server Listen ==================
const PORT = process.env.PORT || 8000;
app.listen(PORT,()=> console.log(`🚀 Server running on port ${PORT}`));
