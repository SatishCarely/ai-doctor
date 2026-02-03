import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import fs from 'fs';
import cors from 'cors';
import OpenAI from 'openai';

const app = express();

app.use(cors());
app.use(express.json());

if (!fs.existsSync('uploads')) {
  fs.mkdirSync('uploads');
}

/* =====================
   Multer (ONE definition)
===================== */
const storage = multer.diskStorage({
  destination: 'uploads/',
  filename: (req, file, cb) => {
    cb(null, `${Date.now()}.webm`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024 },
});

/* =====================
   OpenAI Client
===================== */
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

/* =====================
   VOICE ENDPOINT
===================== */

app.post('/api/analyze', async (req, res) => {
  try {
    const { messages } = req.body;

    if (!Array.isArray(messages)) {
      return res.status(400).json({ error: 'Invalid messages payload' });
    }

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0.3,
      messages,
    });

    res.json({
      content: completion.choices[0]?.message?.content || '',
    });
  } catch (err) {
    console.error('ANALYZE ERROR:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/voice', upload.single('audio'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No audio file provided' });
    }

    const filePath = req.file.path;
    const dischargeSummary = req.body.dischargeSummary || '';

  console.log('Audio saved at:', req.file.path);

const stats = fs.statSync(req.file.path);
console.log('Audio size:', stats.size);

if (stats.size < 1000) {
  fs.unlinkSync(req.file.path);
  return res.json({
    transcription: '',
    responseText: 'I didn’t catch that. Please try speaking a bit longer.',
    audioBase64: null,
    alert: false,
  });
}


const transcription = await openai.audio.transcriptions.create({
  file: fs.createReadStream(req.file.path),
  model: 'whisper-1',
});


    const spokenText = transcription.text?.trim();
    if (!spokenText) {
      return res.json({
        transcription: '',
        responseText: 'I could not hear you clearly. Please try again.',
        audioBase64: null,
        alert: false,
      });
    }

    console.log('Transcription:', spokenText);

    /* 2️⃣ Language detection */
    const isHindi = /[ऀ-ॿ]/.test(spokenText);

    /* 3️⃣ Escalation detection */
    const escalationTriggers = [
  'severe pain',
  'extreme pain',
  'very bad pain',
  'chest pain',
  'shortness of breath',
  'can’t breathe',
  'difficulty breathing',
  'bleeding',
  'bleeding a lot',
  'faint',
  'dizzy',
  'बहुत दर्द',
  'तेज़ दर्द',
  'सांस नहीं',
  'खून',
];


    const needsNurse = escalationTriggers.some(t =>
      spokenText.toLowerCase().includes(t)
    );

    /* 4️⃣ GPT response */
    let aiResponseText;

    if (needsNurse) {
      aiResponseText = isHindi
        ? 'मैं अभी एक अलर्ट बना रहा हूँ ताकि आप सीधे नर्स से बात कर सकें।'
        : 'I am creating an alert now so you can speak with a nurse directly.';
    } else {
      const chat = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        temperature: 0.3,
        messages: [
          {
            role: 'system',
            content:
              'You are a patient follow-up voice assistant. Ask one gentle follow-up question.',
          },
          {
            role: 'system',
            content: `Discharge Summary:\n${dischargeSummary || 'Not provided'}`,
          },
          { role: 'user', content: spokenText },
        ],
      });

      aiResponseText = chat.choices[0]?.message?.content;
    }

    /* 5️⃣ Text → Speech */
    const speech = await openai.audio.speech.create({
      model: 'gpt-4o-mini-tts',
      voice: 'alloy',
      input: aiResponseText,
    });

    const audioBuffer = Buffer.from(await speech.arrayBuffer());

    fs.unlinkSync(filePath);

    res.json({
      transcription: spokenText,
      responseText: aiResponseText,
      audioBase64: audioBuffer.toString('base64'),
      alert: needsNurse,
      language: isHindi ? 'hi' : 'en',
    });
  } catch (err) {
    console.error('VOICE API ERROR:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/voice/init', async (req, res) => {
  try {
    const { dischargeSummary, preferredLanguage } = req.body;

    if (!dischargeSummary) {
      return res.status(400).json({ error: 'Discharge summary required' });
    }

    const isHindi = preferredLanguage === 'hi';

    /* 1️⃣ Generate greeting + summary + question */
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0.2,
      messages: [
        {
          role: 'system',
          content: `
You are a patient follow-up voice assistant.

TASK:
- Extract the patient's name from the discharge summary
- Greet the patient by name
- Briefly summarize their discharge instructions in 1–2 sentences
- Then ask how they are feeling

RULES:
- If the name is missing, use "Dear Patient"
- Speak naturally
- Do NOT use markdown
- Do NOT say "based on the document"
- Respond in ${isHindi ? 'Hindi' : 'English'}
          `,
        },
        {
          role: 'user',
          content: dischargeSummary,
        },
      ],
    });

    const initialPrompt =
      completion.choices[0]?.message?.content?.trim();

    if (!initialPrompt) {
      throw new Error('Failed to generate initial voice prompt');
    }

    /* 2️⃣ Text → Speech */
    const speech = await openai.audio.speech.create({
      model: 'gpt-4o-mini-tts',
      voice: 'alloy',
      input: initialPrompt,
      language: isHindi ? 'hi-IN' : 'en-US',
    });

    const audioBuffer = Buffer.from(await speech.arrayBuffer());

    /* 3️⃣ Send response */
    res.json({
      responseText: initialPrompt,
      audioBase64: audioBuffer.toString('base64'),
      language: isHindi ? 'hi' : 'en',
    });
  } catch (err) {
    console.error('VOICE INIT ERROR:', err);
    res.status(500).json({ error: err.message });
  }
});

const lowerSpoken = spokenText.toLowerCase();

const needsNurse = escalationTriggers.some(trigger =>
  lowerSpoken.includes(trigger)
);

if (needsNurse) {
  const escalationMessage = isHindi
    ? 'मैं Carely नर्स को तुरंत सूचित कर रहा हूँ। वे जल्द ही आपसे संपर्क करेंगी।'
    : 'I will alert the Carely nurse, and they will reach out to you shortly.';

  const speech = await openai.audio.speech.create({
    model: 'gpt-4o-mini-tts',
    voice: 'alloy',
    input: escalationMessage,
    language: isHindi ? 'hi-IN' : 'en-US',
  });

  const audioBuffer = Buffer.from(await speech.arrayBuffer());

  return res.json({
    transcription: spokenText,
    responseText: escalationMessage,
    audioBase64: audioBuffer.toString('base64'),
    alert: true,
    language: isHindi ? 'hi' : 'en',
  });
}

app.post('/api/discharge/intro', async (req, res) => {
  try {
    const { dischargeSummary } = req.body;

    const patientName = await extractPatientName(dischargeSummary);

const initialPrompt = isHindi
  ? `नमस्ते ${patientName}। मैं आपकी डिस्चार्ज जानकारी की समीक्षा कर रहा हूँ। आपने अस्पताल से छुट्टी के बाद कैसा महसूस किया है?`
  : `Hello ${patientName}. I’ve reviewed your discharge summary. How have you been feeling since leaving the hospital?`;

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0.3,
      messages: [
        {
  role: 'system',
  content: `
You are a patient follow-up voice assistant.

Rules:
- If the patient describes severe or dangerous symptoms, DO NOT ask questions
- DO NOT ask to rate pain
- Respond ONLY with a calm reassurance that a nurse will contact them
- Otherwise, ask one gentle follow-up question
- Do not diagnose
`
}
        ,
        {
          role: 'user',
          content: `
Discharge Summary:
${dischargeSummary}

Tasks:
1. Greet the patient by name
2. Briefly summarize the discharge summary in plain language
3. Say you will now ask some follow-up questions
`
        }
      ]
    });

    res.json({
      patientName,
      introText: completion.choices[0].message.content
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
app.post('/api/discharge/intro', async (req, res) => {
  try {
    const { dischargeSummary } = req.body;

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0.2,
      messages: [
        {
          role: 'system',
          content: `
You are a healthcare assistant.

TASK:
1. Extract the patient's full name from the discharge summary.
2. Briefly summarize the key medical instructions in 2–3 sentences.
3. Address the patient by name.
4. End with a gentle follow-up question.

If the name is not present, say "Dear Patient".
Do NOT use markdown.
          `,
        },
        {
          role: 'user',
          content: dischargeSummary,
        },
      ],
    });

    res.json({
      introText: completion.choices[0].message.content,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


/* =====================
   START SERVER
===================== */
app.listen(3001, () => {
  console.log('Backend running on http://localhost:3001');
});
