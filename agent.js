const axios = require('axios');
const { SpeechClient } = require('@google-cloud/speech').v1;
const { ImageAnnotatorClient } = require('@google-cloud/vision').v1;
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');

// إعدادات gRPC الأساسية
process.env.GRPC_DNS_RESOLVER = 'native';
process.env.GRPC_VERBOSITY = 'DEBUG';

class AIAgent {
  constructor() {
    // إعدادات APIs
    this.elevenLabsKey = process.env.ELEVENLABS_KEY;
    this.openRouterKey = process.env.OPENROUTER_API_KEY;
    this.groqKey = process.env.GROQ_API_KEY;
    this.removeBgKey = process.env.REMOVEBG_KEY;

    // جلسات المحادثة
    this.sessions = {};

    // عملاء Google Cloud
    this.speechClient = this._initializeGoogleClient('speech');
    this.visionClient = this._initializeGoogleClient('vision');
  }

  _initializeGoogleClient() {
  try {
    // الطريقة المفضلة - استخدام ملف مباشر
    const credsPath = path.join(__dirname, '..', 'google-credentials.json');
    if (fs.existsSync(credsPath)) {
      const credentials = require(credsPath);
      return new SpeechClient({ credentials });
    }

    // الطريقة الاحتياطية - استخدام متغير البيئة
    if (process.env.GOOGLE_CREDENTIALS) {
      const fixedJson = process.env.GOOGLE_CREDENTIALS
        .replace(/\\n/g, '\n')
        .replace(/\\"/g, '"');
      
      return new SpeechClient({ 
        credentials: JSON.parse(fixedJson) 
      });
    }

    throw new Error('لم يتم العثور على بيانات الاعتماد');
  } catch (error) {
    console.error('❌ فشل التهيئة:', error.message);
    console.log('🔍 تأكد من:');
    console.log('1. صحة تنسيق JSON (جرب في jsonlint.com)');
    console.log('2. أن private_key يحتوي على \\n وليس أسطر جديدة فعلية');
    console.log('3. عدم وجود أحرف خاصة في النص');
    process.exit(1);
  }
}

  // ============== الوظائف الأساسية ==============

  async speechToText(audioBytes, languageCode = 'ar-SA') {
    try {
      const [response] = await this.speechClient.recognize({
        audio: { content: audioBytes },
        config: {
          encoding: 'WEBM_OPUS',
          sampleRateHertz: 48000,
          languageCode: languageCode,
          model: 'latest_long'
        }
      });
      return response.results
        .map(result => result.alternatives[0]?.transcript || '')
        .join('\n');
    } catch (error) {
      console.error('❌ فشل تحويل الصوت إلى نص:', error);
      throw new Error('حدث خطأ أثناء معالجة الصوت');
    }
  }

  async textToSpeech(text, voiceId = '21m00Tcm4TlvDq8ikWAM') {
    try {
      const response = await axios.post(
        `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
        { 
          text,
          voice_settings: { 
            stability: 0.5, 
            similarity_boost: 0.5 
          }
        },
        {
          headers: { 
            'xi-api-key': this.elevenLabsKey,
            'Content-Type': 'application/json'
          },
          responseType: 'arraybuffer'
        }
      );
      return response.data;
    } catch (error) {
      console.error('❌ فشل تحويل النص إلى صوت:', error.response?.data || error.message);
      throw new Error('حدث خطأ أثناء توليد الصوت');
    }
  }

  // ... (بقية الوظائف تبقى كما هي بدون تغيير)

  async handleRequest(sessionId, userInput, inputType = 'text') {
    if (!this.sessions[sessionId]) {
      this.sessions[sessionId] = { chatHistory: [], preferences: {} };
    }
    const session = this.sessions[sessionId];

    let userText = userInput;
    if (inputType === 'audio') {
      userText = await this.speechToText(userInput);
    }

    const task = this.detectTask(userText);
    let output;

    switch (task) {
      case 'code_generation':
        output = await this.generateCode(userText, this.extractLanguage(userText));
        break;
      case 'text_to_speech':
        output = await this.textToSpeech(userText);
        break;
      case 'remove_background':
        output = await this.removeBackground(userInput);
        break;
      default:
        session.chatHistory.push({ role: 'user', content: userText });
        output = await this.chatWithAI(session.chatHistory);
        session.chatHistory.push({ role: 'assistant', content: output });
    }

    return {
      output,
      outputType: task === 'text_to_speech' ? 'audio' : 
                  task === 'remove_background' ? 'image' : 'text'
    };
  }
}

module.exports = AIAgent;