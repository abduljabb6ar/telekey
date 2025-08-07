require("dotenv").config();
var express=require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const axios = require('axios');
const { ImageAnnotatorClient } = require('@google-cloud/vision').v1; 
const multer = require('multer');
const fs = require('fs');
const path = require('path')
const FormData = require('form-data');
const app = express();
const Replicate =require('replicate');
const sharp = require('sharp');
app.use(cors());
const { GoogleGenerativeAI } = require('@google/generative-ai');
app.use(bodyParser.urlencoded({ extended: false }));
app.use(express.json({ limit: '50mb' })); // رفع الحد إلى 50 ميغابايت
app.use(express.urlencoded({ limit: '50mb', extended: true }));


app.set('view engine','ejs');
app.get('/',(req,res)=>{
     res.render("index.ejs")
})

const upload2 =  multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const uploadPath = path.join(__dirname, 'uploads');
      // إنشاء المجلد إذا لم يكن موجوداً
      if (!fs.existsSync(uploadPath)) {
        fs.mkdirSync(uploadPath, { recursive: true });
      }
      cb(null, uploadPath);
    },
    filename: (req, file, cb) => {
      cb(null, Date.now() + path.extname(file.originalname));
    }
  }),
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf') {
      cb(null, true);
    } else {
      cb(new Error('يجب أن يكون الملف من نوع PDF'), false);
    }
  }
});
app.use(bodyParser.urlencoded({ extended: false }));
const client2 = new ImageAnnotatorClient({
  keyFilename:  JSON.parse(process.env.GOOGLE_CREDENTIALS), // المسار إلى ملف JSON
});




app.get('/health', (req, res) => {
  res.status(200).json({ status: 'OK' });
});

const upload = multer({ storage: multer.memoryStorage() });
app.use(cors());
app.set('view engine','ejs');
app.get('/',(req,res)=>{
    res.render("index.ejs")
})


// app.post('/templates', async (req, res) => {
//   try {
//     console.log("PIXVERSE_KEY:", process.env.PIXVERSE_KEY?.substring(0, 5) + "..."); // للتأكد من وجود المفتاح

//     const response = await axios.get('https://api.pixapi.pro/api/pvTemplates', {
//       headers: {
//         Authorization: `Bearer ${process.env.PIXVERSE_KEY}`
//       },
//       params: {
//         accountId: "350878975345589" // استبدلها بالقيمة الفعلية
//       }
//     });

//     res.json(response.data.items || response.data.templates || response.data.result || []);
//   } catch (err) {
//     console.error("API Error:", {
//       message: err.message,
//       status: err.response?.status,
//       data: err.response?.data
//     });
//     res.status(500).json({ 
//       error: 'Failed to fetch templates',
//       details: err.response?.data || err.message 
//     });
//   }
// });

app.get('/templates', async (req, res) => {
  try {
    const response = await axios.get('https://api.pixapi.pro/api/pvTemplates', {
      headers: {
        Authorization: `Bearer ${process.env.PIXVERSE_KEY}`
      },
      params: {
        accountId:""
      }
    });
    console.log("Body:", response.data); // فقط للتحقق
    res.json(response.data.items || response.data.templates || response.data.result || []);
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to fetch templates' });
  }
});

const replicate = new Replicate({
  auth: process.env.REPLICATE_API_TOKEN, // تأكد من وجود هذا في .env
});



app.post('/generate32', async (req, res) => {
  const { prompt } = req.body;
  console.log('📥 Received request with prompt:', prompt);

  const options = {
    method: 'POST',
    url: 'https://runwayml.p.rapidapi.com/generate/text',
    headers: {
      'x-rapidapi-key': '',
      'x-rapidapi-host': 'runwayml.p.rapidapi.com',
      'Content-Type': 'application/json'
    },
    data: {
      model: 'gen2',
      text_prompt: prompt,
      motion: 5,
      seed: 42,
      callback_url: 'http://localhost:8000/callback'
    }
  };

  try {
    const response = await axios.request(options);
    console.log('✅ Response from RunwayML:', response.data);
    res.json({
      message: 'Video is being generated',
      uuid: response.data.uuid
    });
  } catch (error) {
    console.error('❌ Error while contacting RunwayML API');

    if (error.response) {
      // الخادم رد برمز خطأ
      console.error('🔴 Status:', error.response.status);
      console.error('📝 Response data:', error.response.data);
      console.error('📋 Headers:', error.response.headers);

      res.status(500).json({
        error: true,
        message: 'RunwayML API returned an error',
        status: error.response.status,
        response: error.response.data
      });

    } else if (error.request) {
      // لم يتم تلقي رد من الخادم
      console.error('⚠️ No response received from RunwayML');
      console.error('📡 Request:', error.request);

      res.status(500).json({
        error: true,
        message: 'No response received from RunwayML API'
      });

    } else {
      // خطأ أثناء إعداد الطلب نفسه
      console.error('⚠️ Error setting up the request:', error.message);

      res.status(500).json({
        error: true,
        message: 'Error setting up request to RunwayML API',
        detail: error.message
      });
    }

    // طباعة Stack Trace
    console.error('📍 Stack Trace:', error.stack);
  }
});
app.get('/status/:uuid', async (req, res) => {
  const uuid = req.params.uuid;

  const options = {
    method: 'GET',
    url: `https://runwayml.p.rapidapi.com/status`,
    params: { uuid },
    headers: {
      'x-rapidapi-key': '',
      'x-rapidapi-host': 'runwayml.p.rapidapi.com'
    }
  };

  try {
    const response = await axios.request(options);
    res.json(response.data);
  } catch (error) {
    console.error('❌ Error fetching status:', error.message);
    res.status(500).json({ error: true, message: 'Failed to fetch status' });
  }
});

app.get('/callback/:uuid', async (req, res) => {
  const uuid = req.params.uuid;

  try {
    const result = await axios.get(`https://api.runwayml.com/v1/async/tasks/${uuid}`, {
      headers: {
        Authorization: `Bearer ${process.env.RUNWAY_API_KEY}`,
        'Content-Type': 'application/json',
      },
    });

    if (result.data.status === 'succeeded') {
      res.json({
        status: 'succeeded',
        video_url: result.data.output, // قد يكون output رابط أو كائن
      });
    } else {
      res.json({
        status: result.data.status,
        message: 'Still processing...'
      });
    }
  } catch (err) {
    console.error("خطأ في جلب حالة الفيديو:", err.response?.data || err.message);
    res.status(500).json({ error: true, message: err.message });
  }
});





app.post('/instagram/profile2', async (req, res) => {
  const { username } = req.body;
  if (!username) {
    return res.status(400).json({ error: 'username is required' });
  }
  try {
    const convertResponse = await axios.get('https://instagram-api-fast-reliable-data-scraper.p.rapidapi.com/user_id_by_username', {
      params: { username },
      headers: {
        'x-rapidapi-key': "",
        'x-rapidapi-host': 'instagram-api-fast-reliable-data-scraper.p.rapidapi.com',
      },
    });
    const user_id = convertResponse.data.UserID;
    if (!user_id) return res.status(404).json({ error: 'User ID not found for this username' });

    const headers = {
      'x-rapidapi-key': '',
      'x-rapidapi-host': 'instagram-api-fast-reliable-data-scraper.p.rapidapi.com',
    };

    // جلب بيانات البروفايل فقط لتجنب الأخطاء
    const profileResponse = await axios.get(`https://instagram-api-fast-reliable-data-scraper.p.rapidapi.com/profile`, {
      params: { user_id },
      headers
    });

    res.json({ profile: profileResponse.data });

  } catch (error) {
    console.error('Error fetching Instagram profile:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to fetch Instagram profile' });
  }
});
const upload3 = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const uploadDir = 'temp_uploads';
      if (!fs.existsSync(uploadDir)) {
        fs.mkdirSync(uploadDir, { recursive: true });
      }
      cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, `${Date.now()}${ext}`);
    }
  }),
  limits: {
    fileSize: 10 * 1024 * 1024 // 10MB
  }
});

// 2. Middleware للتحقق من الملفات
const validateImage = async (req, res, next) => {
  if (!req.file) {
    return res.status(400).json({ 
      error: 'لم يتم تحميل أي ملف',
      solution: 'يجب اختيار صورة من الأنواع التالية: JPG, PNG, WEBP'
    });
  }

  try {
    const imageBuffer = req.file.buffer || fs.readFileSync(req.file.path);
    const metadata = await sharp(imageBuffer).metadata();

    // التحقق من أن الصورة مدعومة
    if (!['jpeg', 'png', 'webp'].includes(metadata.format)) {
      return res.status(400).json({
        error: 'نوع الملف غير مدعوم',
        detectedFormat: metadata.format,
        allowedFormats: ['JPEG', 'PNG', 'WEBP']
      });
    }

    // تخزين بيانات الصورة للاستخدام لاحقاً
    req.imageBuffer = imageBuffer;
    req.imageMetadata = metadata;
    next();
  } catch (error) {
    console.error('Image validation error:', error);
    return res.status(400).json({
      error: 'ملف غير صالح',
      details: 'الملف إما تالف أو ليس صورة مدعومة'
    });
  }
};

// 3. معالجة وتحويل الصورة
const processImage = async (imageBuffer) => {
  try {
    // الحصول على أبعاد الصورة الأصلية
    const metadata = await sharp(imageBuffer).metadata();
    
    // تحديد الأبعاد المستهدفة (سنستخدم 1024x1024 كمثال)
    const targetWidth = 1024;
    const targetHeight = 1024;
    
    // معالجة الصورة مع الحفاظ على نسبة الطول/العرض
    const processedImage = await sharp(imageBuffer)
      .resize({
        width: targetWidth,
        height: targetHeight,
        fit: 'cover', // سيقطع الصورة لملء الأبعاد المطلوبة
        position: 'center', // سيأخذ من المركز عند القص
        withoutEnlargement: false // يسمح بتكبير الصورة إذا كانت صغيرة
      })
      .png({
        quality: 90,
        compressionLevel: 6
      })
      .toBuffer();

    const base64 = processedImage.toString('base64');
    console.log(`Image processed - Dimensions: ${targetWidth}x${targetHeight}, Size: ${Math.round(base64.length * 3 / 4 / 1024)}KB`);
    return base64;
  } catch (error) {
    console.error('Image processing failed:', error);
    throw new Error('فشل في معالجة الصورة: ' + error.message);
  }
};

// 4. الاتصال بـ Stability API
const callStabilityAPI = async (base64Image, prompt) => {
  try {
    // تحويل base64 إلى Buffer
    const imageBuffer = Buffer.from(base64Image, 'base64');
    
    // إنشاء FormData
    const formData = new FormData();
    
    // إضافة الصورة كملف
    formData.append('init_image', imageBuffer, {
      filename: 'input.png',
      contentType: 'image/png',
      knownLength: imageBuffer.length
    });
    
    // إضافة المعاملات الأخرى
    formData.append('text_prompts[0][text]', prompt.trim());
    formData.append('text_prompts[0][weight]', '1');
    formData.append('cfg_scale', '13');
    formData.append('steps', '50');
    formData.append('seed', Math.floor(Math.random() * 1000000).toString());

    // إعداد headers مع boundary المخصص
    const headers = {
      'Authorization': `Bearer ${process.env.STABILITY_API_KEY}`,
      'Accept': 'application/json',
      ...formData.getHeaders()
    };

    console.log('Request Headers:', headers);
    console.log('FormData Boundary:', formData.getBoundary());

    const response = await axios.post(
      'https://api.stability.ai/v1/generation/stable-diffusion-xl-1024-v1-0/image-to-image',
      formData,
      {
        headers: headers,
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
        timeout: 60000
      }
    );

    return response.data;
  } catch (error) {
    console.error('API Call Detailed Error:', {
      status: error.response?.status,
      data: error.response?.data,
      config: error.config,
      message: error.message,
      stack: error.stack
    });
    
    throw new Error(`فشل في استدعاء API: ${error.response?.data?.message || error.message}`);
  }
};

// 5. حفظ الصورة الناتجة
const saveOutputImage = (base64Data) => {
  try {
    const outputDir = 'uploads';
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    const outputFilename = `output_${Date.now()}.png`;
    const outputPath = path.join(outputDir, outputFilename);

    fs.writeFileSync(outputPath, Buffer.from(base64Data, 'base64'), { flag: 'wx' });

    return {
      path: outputPath,
      url: `/uploads/${outputFilename}`,
      filename: outputFilename
    };
  } catch (error) {
    console.error('Save Image Error:', error);
    throw new Error('فشل في حفظ الصورة الناتجة');
  }
};

// 6. نقطة النهاية الرئيسية
app.post('/api/edit-image', upload3.single('image'), validateImage, async (req, res) => {
  try {
    const { prompt } = req.body;

    // 1. التحقق من صحة البرومبت
    if (!prompt || prompt.trim().length < 5) {
      return res.status(400).json({ 
        error: 'وصف غير صالح',
        solution: 'يجب أن يحتوي الوصف على 5 أحرف على الأقل'
      });
    }

    console.log('بدء معالجة الصورة...');
    
    // 2. معالجة الصورة
    const base64Image = await processImage(req.imageBuffer);

    console.log('استدعاء Stability API...');
    
    // 3. استدعاء API
    const apiResponse = await callStabilityAPI(base64Image, prompt);

    if (!apiResponse.artifacts?.length) {
      return res.status(500).json({
        error: 'لا توجد صور مسترجعة من API',
        solution: 'حاول مرة أخرى مع وصف مختلف'
      });
    }

    // 4. الحصول على الصورة الناتجة (بدون حفظها في ملف)
    const result = apiResponse.artifacts[0];
    
    // 5. إرسال الاستجابة مع بيانات الصورة مباشرة
    res.json({
      success: true,
      imageBase64: result.base64, // إرسال بيانات الصورة مباشرة
      imageInfo: {
        format: 'png',
        dimensions: '1024x1024',
        size: `${Math.round(result.base64.length * 3 / 4 / 1024)}KB`
      },
      promptUsed: prompt,
      generatedAt: new Date().toISOString()
    });

  } catch (error) {
    console.error('Endpoint Error:', error);
    res.status(500).json({
      error: 'خطأ في المعالجة',
      details: error.message,
      solution: 'حاول مرة أخرى مع صورة مختلفة أو اتصل بالدعم الفني',
      referenceId: Date.now().toString(36)
    });
  }
});
const BASE_URL = 'https://api.elevenlabs.io/v1';

// 1. جلب قائمة الأصوات
app.get('/voices', async (req, res) => {
  try {
    const response = await axios.get(`${BASE_URL}/voices`, {
      headers: { 'xi-api-key': process.env.ELEVENLABS_KEY }
    });
    res.json(response.data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 2. تحويل نص إلى صوت
app.post('/text-to-speech/:voiceId', async (req, res) => {
  try {
    const voiceId = req.params.voiceId;
    const { text, stability = 0.5, similarity_boost = 0.5 } = req.body;

    const response = await axios.post(
      `${BASE_URL}/text-to-speech/${voiceId}`,
      { text, voice_settings: { stability, similarity_boost } },
      {
        headers: {
          'xi-api-key': process.env.ELEVENLABS_KEY,
          'Content-Type': 'application/json'
        },
        responseType: 'arraybuffer'
      }
    );

    res.set('Content-Type', 'audio/mpeg');
    res.send(response.data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 3. رفع ملف صوت لاستنساخ الصوت (Voice Cloning)
app.post('/voice-clone', upload.single('voiceFile'), async (req, res) => {
  try {
    const { filename, path } = req.file;
    const formData = new FormData();

    formData.append('files', fs.createReadStream(path));
    // إضافة بيانات أخرى حسب API ElevenLabs إن وجدت، هنا مجرد مثال

    const response = await axios.post(
      `${BASE_URL}/voices/add`,
      formData,
      {
        headers: {
          ...formData.getHeaders(),
          'xi-api-key': process.env.ELEVENLABS_KEY,
        }
      }
    );

    // حذف الملف بعد الرفع
    fs.unlinkSync(path);

    res.json(response.data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});


const speech = require('@google-cloud/speech');

const client = new speech.SpeechClient({
  credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS),
});

const sessions2 = {}; // لتخزين المحادثات حسب sessionId
const { v4: uuidv4 } = require('uuid');

// دالة بديلة لتحويل النص إلى صوت باستخدام نظام التشغيل (Linux/macOS)
async function textToSpeechFallback(text, language = 'ar') {
  const outputFile = path.join('/tmp', `${uuidv4()}.wav`);
  
  return new Promise((resolve, reject) => {
    const command = `espeak -v ${language} "${text}" --stdout > ${outputFile}`;
    
    require('child_process').exec(command, async (error) => {
      if (error) {
        reject(error);
        return;
      }
      
      try {
        const audioData = await fs.promises.readFile(outputFile);
        await fs.promises.unlink(outputFile);
        resolve(audioData);
      } catch (err) {
        reject(err);
      }
    });
  });
}
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY)
app.post('/api/speech-to-voice', async (req, res) => {
  try {
    const audioBytes = req.body.audio;
    const voiceId = req.body.voiceId || '9BWtsMINqrJLrRacOk9x';
    const sessionId = req.body.sessionId || 'default-session';

    // 1. تحويل الصوت إلى نص
    const [response] = await client.recognize({
      audio: { content: audioBytes },
      config: {
        encoding: 'WEBM_OPUS',
        sampleRateHertz: 48000,
        languageCode: 'ar-SA',
      },
    });

    const transcription = response.results
      .map(result => result.alternatives[0].transcript)
      .join('\n');

    console.log('🎤 Transcription:', transcription);

    // 2. إعداد جلسة Gemini
    if (!sessions2[sessionId]) sessions2[sessionId] = [];

    sessions2[sessionId].push({
      role: 'user',
      parts: [{ text: transcription }]
    });

    const model = genAI.getGenerativeModel({ model: "gemini-1.5-pro" });

    const result = await model.generateContent({
      contents: sessions2[sessionId]
    });

    const reply = result.response.text();
    console.log('💬 Gemini Reply:', reply);

    sessions2[sessionId].push({
      role: 'model',
      parts: [{ text: reply }]
    });

    // 3. تحويل النص إلى صوت باستخدام ElevenLabs
    let audioData;
    let contentType = 'audio/mpeg';

    try {
      const ttsResponse = await axios.post(
        `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
        {
          text: reply,
          voice_settings: {
            stability: 0.5,
            similarity_boost: 0.5
          }
        },
        {
          headers: {
            'xi-api-key': process.env.ELEVENLABS_KEY,
            'Content-Type': 'application/json',
            'accept': 'audio/mpeg'
          },
          responseType: 'arraybuffer',
          timeout: 15000
        }
      );

      audioData = ttsResponse.data;
    } catch (ttsError) {
      console.error('🔁 ElevenLabs TTS failed:', ttsError.message);
      throw new Error('تحويل النص إلى صوت باستخدام ElevenLabs فشل');
    }

    // 4. إرسال الصوت للواجهة
    res.set('Content-Type', contentType);
    res.send(audioData);

  } catch (error) {
    console.error('❌ Error details:', {
      message: error.message,
      response: error.response?.data,
      stack: error.stack
    });

    const statusCode = error.response?.status || 500;
    res.status(statusCode).json({
      error: 'حدث خطأ أثناء المعالجة',
      details: error.response?.data || error.message,
      suggestion: 'تحقق من مفاتيح API أو الصيغة أو الرصيد المتاح'
    });
  }
});
app.post('/generate-text', async (req, res) => {
  const { prompt } = req.body;

  if (!prompt) {
    return res.status(400).json({ error: 'الرجاء إدخال prompt في جسم الطلب' });
  }

  try {
    const response = await axios.post(
      'https://api-inference.huggingface.co/models/HuggingFaceH4/starchat-alpha', // استبدل بالنموذج الذي تريد استخدامه
      { inputs: prompt },
      {
        headers: {
          Authorization: `Bearer ${process.env.HUGGINGFACE_KEY}`,
          'Content-Type': 'application/json',
        },
      }
    );

    // response.data عادة تكون مصفوفة نصوص توليد
    res.json(response.data);
  } catch (error) {

    console.error('Error from Hugging Face API:', error.response?.data || error.message);
    res.status(500).json({ error: 'فشل في توليد النص' });
  }
});


app.post('/generate-code', async (req, res) => {
  const { prompt, language } = req.body;

  try {
    const response = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model: "llama3-8b-8192",
        messages: [
          {
            role: 'system',
            content: `You are an expert code generator. Please respond only with code in the ${language} programming language, without any explanations.`,
          },
          {
            role: 'user',
            content: prompt,
          },
        ],
        temperature: 0.7,
      },
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
        },
      }
    );

    const generatedText = response.data.choices[0]?.message?.content || 'No response.';
    res.json({ generated_text: generatedText });
  } catch (error) {
    console.error('Error from Groq API:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to generate code' });
  }
});



const uploadd = multer({ storage: multer.memoryStorage() });;
app.post('/remove-bg', uploadd.single('image'), async (req, res) => {
  console.log("ddd");

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
      responseType: 'arraybuffer', // نحصل على الصورة الناتجة كـ Buffer
    });

    res.set('Content-Type', 'image/png');
    res.send(response.data);

  } catch (error) {
    console.error('Error from remove.bg:', error.response?.data || error.message);
    res.status(500).send('Failed to remove background');
  }
});


const sessions = {}; // key = sessionId, value = array of messages


const MAX_HISTORY_LENGTH = 20;

app.post('/chat2', async (req, res) => {
  const { message, sessionId } = req.body;
  console.log('Request body:', req.body);

  if (!message || !sessionId) {
    return res.status(400).json({ error: "الرسالة أو sessionId مفقود" });
  }

  // أنشئ جلسة إذا لم تكن موجودة
  if (!sessions[sessionId]) {
    sessions[sessionId] = [];
  }

  // أضف رسالة المستخدم إلى الجلسة
  sessions[sessionId].push({ role: "user", parts: [{ text: message }] });

  // نأخذ فقط آخر MAX_HISTORY_LENGTH رسالة لتقليل حجم البيانات المرسلة
  const conversation = sessions[sessionId].slice(-MAX_HISTORY_LENGTH);

  try {
    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-pro-latest' });

    // إرسال كامل المحادثة (آخر 20 رسالة)
    const result = await model.generateContent({
      contents: conversation,
    });

    const reply = result.response.text();

    // أضف رد المساعد إلى الجلسة
    sessions[sessionId].push({ role: "model", parts: [{ text: reply }] });

    // أرسل الرد في JSON
    res.json({ reply });
  } catch (error) {
    console.error("❌ Gemini API Error:", error);
    res.status(500).json({ error: "حدث خطأ في الرد من Gemini" });
  }
});
// app.post('/chat2', async (req, res) => {
//   const { message, sessionId } = req.body;
//   if (!message || !sessionId) {
//     return res.status(400).json({ error: "الرسالة أو sessionId مفقود" });
//   }

//   // استخدم sessionId لتخزين المحادثة
//   if (!sessions[sessionId]) {
//     sessions[sessionId] = []; // جلسة جديدة
//   }

//   // أضف رسالة المستخدم
//   sessions[sessionId].push({ role: "user", content: message });

//   try {
//     const response = await axios.post(
//       'https://openrouter.ai/api/v1/chat/completions',
//       {
//         model: 'mistralai/mistral-7b-instruct',
//         messages: sessions[sessionId],
//       },
//       {
//         headers: {
//           'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
//           'Content-Type': 'application/json',
//         },
//       }
//     );

//     const reply = response.data.choices[0].message.content;

//     // أضف رد النموذج لذاكرة الجلسة
//     sessions[sessionId].push({ role: "assistant", content: reply });
//     console.log("📩 Received Body:", req.body);

//     res.send(reply);
//   } catch (error) {
//     console.error("❌ OpenRouter error:", error.response?.data || error.message);
//     res.status(500).send("حدث خطأ في الرد من الذكاء الاصطناعي");
//   }
// });



app.post('/convert', upload2.single('file'), async (req, res) => {
   let tempFilePath = null;
  try {
    if (!req.file) {
      return res.status(400).json({ error: true, message: 'لم يتم توفير ملف' });
    }

     tempFilePath = req.file.path;
    const targetFormat = req.body.target;
    if (!['xlsx', 'docx'].includes(targetFormat)) {
      return res.status(400).json({ error: true, message: 'صيغة التحويل غير مدعومة' });
    }

    // 1. رفع الملف إلى PDF.co
    const uploadedFile = await uploadToPdfCo(req.file.buffer, req.file.originalname || 'document.pdf');
    
    if (uploadedFile.error) {
      return res.status(500).json(uploadedFile);
    }

    // 2. تحويل الملف
    const conversionResult = await convertFile(uploadedFile.fileId, targetFormat);
    
    if (conversionResult.error) {
      return res.status(500).json(conversionResult);
    }

    // 3. تحميل الملف المحول
    const convertedFile = await downloadFile(conversionResult.url);
    
    // 4. إرسال الملف المحول إلى العميل
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename=converted.${targetFormat}`);
    res.send(convertedFile);

  } catch (error) {
    console.error('حدث خطأ:', error);
    res.status(500).json({ error: true, message: 'حدث خطأ أثناء التحويل' });
  } finally {
    // تنظيف الملفات المؤقتة
    if (tempFilePath) {
      fs.unlink(tempFilePath, (err) => {
        if (err) console.error('خطأ في حذف الملف المؤقت:', err);
      });
    }
  }
});

async function uploadToPdfCo(filePath, fileName) {
  try {
    const formData = new FormData();
    formData.append('file',filePath, fileName);

    const response = await axios.post(`https://api.pdf.co/v1/file/upload`, formData, {
      headers: {
        'x-api-key': process.env.PDF_API_KEY,
        ...formData.getHeaders()
      }
    });

    return response.data;
  } catch (error) {
    console.error('خطأ في رفع الملف:', error.response?.data || error.message);
    return { error: true, message: 'فشل رفع الملف إلى PDF.co' };
  }
}

async function convertFile(fileId, targetFormat) {
  try {
    const endpoint = targetFormat === 'xlsx' ? 'pdf/convert/to/excel' : 'pdf/convert/to/doc';

    const response = await axios.post(`https://api.pdf.co/v1/${endpoint}`, {
      url: fileId,
      async: false,
      encrypt: false,
      inline: false
    }, {
      headers: {
        'x-api-key': process.env.PDF_API_KEY,
        'Content-Type': 'application/json'
      }
    });

    return response.data;
  } catch (error) {
    console.error('خطأ في التحويل:', error.response?.data || error.message);
    return { error: true, message: 'فشل تحويل الملف' };
  }
}

async function downloadFile(url) {
  try {
    const response = await axios.get(url, { responseType: 'arraybuffer' });
    return response.data;
  } catch (error) {
    console.error('خطأ في تحميل الملف المحول:', error.message);
    throw new Error('فشل تحميل الملف المحول');
  }
}












app.get('/search', async (req, res) => {
  const q = req.query.q;

  try {
    const response = await axios.get('https://axesso-axesso-amazon-data-service-v1.p.rapidapi.com/amz/amazon-search-by-keyword-asin', {
      params: {
        keyword: q,
        domainCode: 'com',
        page: '1'
      },
      headers: {
        'X-RapidAPI-Key': process.env.RAPIDAPI_KEY,
        'X-RapidAPI-Host': 'axesso-axesso-amazon-data-service-v1.p.rapidapi.com'
      }
    });

    res.json(response.data);
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: 'API request failed' });
  }
});


app.post('/detect-labels', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'لم يتم تقديم صورة' });
    }

    // الهيكل الصحيح للطلب
    const [result] = await client.annotateImage({
      image: { content: req.file.buffer.toString('base64') },
      features: [{ type: 'LABEL_DETECTION' }], // تحديد الميزة المطلوبة
    });

    const labels = result.labelAnnotations.map(label => ({
      description: label.description,
      score: label.score,
    }));

    res.json({ labels });
  } catch (error) {
    console.error('Vision API Error:', error);
    res.status(500).json({ 
      error: 'فشل في معالجة الصورة',
      details: error.message 
    });
  }
});
app.post('/chat', async (req, res) => {
  const { message } = req.body;

   try {
    const response = await axios.post(
      'https://openrouter.ai/api/v1/chat/completions',
      {
        model: 'openai/gpt-3.5-turbo',
        messages: [{ role: 'user', content: message }],
      },
      {
        headers: {
          'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
          'Content-Type': 'application/json',
        },
      }
      
    );
 const reply = response.data.choices[0].message.content;
    // console.log(" GPT Reply:", reply);

    // ✅ إرسال رد واحد فقط
    // return res.status(200).send("✅ تم طباعة الرد في السيرفر");
res.send(reply); 
    // return response.data.choices[0].message.content;
  } catch (error) {
    console.error('❌ OpenRouter error:', error.response?.data || error.message);
    return 'عذرًا، حدث خطأ أثناء الاتصال بالنموذج.';
  }
});


app.post('/chat3', async (req, res) => {
  const { message, sessionId } = req.body;

  if (!message || !sessionId) {
    return res.status(400).json({ error: "الرسالة أو sessionId مفقود" });
  }

  // صورة أم نص؟
  const isImageRequest = message.toLowerCase().includes("draw") ;

  // if (isImageRequest) {
    // إرسال إلى Stability AI (إنشاء صورة)
    try {
      const response = await axios.post(
        'https://api.stability.ai/v1/generation/stable-diffusion-xl-1024-v1-0/text-to-image',
        {
    text_prompts: [{ text: message }],
    cfg_scale: 7,
    height: 1024,
    width: 1024,
    samples: 1,
    steps: 30,
  },
  {
    headers: {
      'Authorization': `Bearer ${process.env.STABILITY_API_KEY}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
  }
);

      const imageBase64 = response.data.artifacts[0].base64;
      res.json({ image: imageBase64 }); // 👈 نرسل الصورة إلى Flutter بصيغة Base64

    } catch (error) {
      console.error("❌ خطأ في توليد الصورة:", error.response?.data || error.message);
      return res.status(500).json({ error: "حدث خطأ أثناء توليد الصورة" });
  //   }
  // } else {
  //   // رد نصي عادي من OpenRouter
  //   if (!sessions[sessionId]) sessions[sessionId] = [];

  //   sessions[sessionId].push({ role: "user", content: message });

  //   try {
  //     const response = await axios.post(
  //       'https://openrouter.ai/api/v1/chat/completions',
  //       {
  //         model: 'openai/gpt-3.5-turbo',
  //         messages: sessions[sessionId],
  //       },
  //       {
  //         headers: {
  //           'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
  //           'Content-Type': 'application/json',
  //         },
  //       }
  //     );

  //     const reply = response.data.choices[0].message.content;
  //     sessions[sessionId].push({ role: "assistant", content: reply });

  //     res.json({ reply }); // 👈 رد نصي
  //   } catch (error) {
  //     console.error("❌ OpenRouter error:", error.response?.data || error.message);
  //     res.status(500).send("حدث خطأ في الرد من الذكاء الاصطناعي");
  //   }
  }
});

app.post('/chatdeepseek', async (req, res) => {
  try {
    const userMessage = req.body.message; // الرسالة المرسلة من Flutter

    if (!userMessage) {
      return res.status(400).json({ error: 'يجب إرسال رسالة نصية' });
    }

    // إرسال الطلب إلى DeepSeek API
    const response = await axios.post(
      'https://api.deepseek.com/v1/chat/completions',
      {
        model: "deepseek-chat",
        messages: [{ role: "user", content: userMessage }],
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.DEEBSEEK_API_KEY}`,
        },
      }
    );

    // إرسال الإجابة إلى Flutter
    const aiResponse = response.data.choices[0].message.content;
    res.json({ reply: aiResponse });

  } catch (error) {
    console.error('Error:', error.response?.data || error.message);
    
    // إرسال رسالة خطأ واضحة بناءً على حالة الـ API
    if (error.response?.status === 402) {
      res.status(402).json({ error: 'الاشتراك غير كافي. يرجى تجديد الخطة في DeepSeek.' });
    } else {
      res.status(500).json({ error: 'حدث خطأ أثناء معالجة السؤال' });
    }
  }
});
app.listen(3000, () => {
  console.log('🚀 Server running on http://localhost:3000');
});
