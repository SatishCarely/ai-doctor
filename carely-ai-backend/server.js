import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import cors from 'cors';
import OpenAI from 'openai';
import QRCode from 'qrcode';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';
import os from 'os';
import { createHmac } from 'crypto';
import { RoomServiceClient, AgentDispatchClient } from 'livekit-server-sdk';

const app = express();
app.use(cors());
app.use(express.json());

if (!fs.existsSync('uploads')) fs.mkdirSync('uploads');

const PORT = process.env.PORT || 3000;

/* ===================== Multer ===================== */
const storage = multer.diskStorage({
  destination: 'uploads/',
  filename: (req, file, cb) => cb(null, `${Date.now()}.webm`),
});
const upload = multer({ storage, limits: { fileSize: 25 * 1024 * 1024 } });
const panUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

/* ===================== OpenAI ===================== */
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || 'dummy' });
let openaiCallCount = 0;

async function trackOpenAICall(label, fn) {
  openaiCallCount++;
  const n = openaiCallCount;
  const start = Date.now();
  console.log(`\n[OPENAI #${n}] ${label} — START`);
  try {
    const result = await fn();
    console.log(`[OPENAI #${n}] ${label} — OK (${Date.now() - start}ms)`);
    return result;
  } catch (err) {
    console.log(`[OPENAI #${n}] ${label} — FAIL (${Date.now() - start}ms)`);
    throw err;
  }
}

/* ===================== Constants ===================== */
const KYC_LANGUAGE_NAMES = {
  en: 'English', hi: 'Hindi', bn: 'Bengali', te: 'Telugu', ta: 'Tamil',
  mr: 'Marathi', gu: 'Gujarati', kn: 'Kannada', ml: 'Malayalam',
  pa: 'Punjabi', or: 'Odia', ur: 'Urdu',
};

const DOCTOR_TTS_INSTRUCTIONS = [
  'Speak in a calm, professional female Indian English accent, like a reassuring doctor speaking clearly to a patient.',
  'Sound like a middle-aged Indian female doctor or care assistant.',
  'Keep the tone warm, clear, confident, and reassuring.',
  'Use a slightly slower pace with natural phrasing.',
  'Avoid exaggerated emotion or dramatic emphasis.',
].join(' ');

const DOCTOR_TTS_SPEED = 0.94;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_KYC_PDF_PATH = path.resolve(__dirname, './kyc-templates/default-kyc.pdf');

// LiveKit
const LIVEKIT_URL = process.env.LIVEKIT_URL;
const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY;
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET;

// Beyond Presence (kept for reference / stop-session cleanup only)
const BEY_API_BASE = 'https://api.bey.dev';
const BEY_API_KEY = process.env.BEY_API_KEY;

const BEY_SUPPORTED_LANGUAGE_CODES = new Set([
  'ar','ar-SA','bn','bg','zh','cs','da','nl','en','en-AU','en-GB','en-US',
  'fi','fr','fr-CA','fr-FR','de','el','hi','hu','id','it','ja','kk','ko',
  'ms','no','pl','pt','pt-BR','pt-PT','ro','ru','sk','es','sv','tr','uk','ur','vi',
]);
const BEY_LANGUAGE_FALLBACKS = { mr:'en', gu:'en', pa:'en', or:'en', te:'en', ta:'en', kn:'en', ml:'en' };

/* ===================== Session stores ===================== */
const panSessions = new Map();
const PAN_SESSION_TTL_MS = 15 * 60 * 1000;
const s2vSessions = new Map();
const S2V_SESSION_TTL_MS = 30 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [id, s] of panSessions) if (now - s.createdAt > PAN_SESSION_TTL_MS) panSessions.delete(id);
  for (const [id, s] of s2vSessions) if (now - s.createdAt > S2V_SESSION_TTL_MS) s2vSessions.delete(id);
}, 60_000);

/* ===================== Helpers ===================== */
function getKycLanguageName(code) { return KYC_LANGUAGE_NAMES[code] || 'English'; }

function getBeyondPresenceLanguageCode(code) {
  const normalized = String(code || 'en').trim();
  if (BEY_SUPPORTED_LANGUAGE_CODES.has(normalized)) return normalized;
  return BEY_LANGUAGE_FALLBACKS[normalized] || 'en';
}

function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return 'localhost';
}

function base64UrlEncode(value) {
  const input = typeof value === 'string' ? value : JSON.stringify(value);
  return Buffer.from(input).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/g,'');
}

function createJwtHS256(payload, secret) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const encodedHeader = base64UrlEncode(header);
  const encodedPayload = base64UrlEncode(payload);
  const signature = createHmac('sha256', secret)
    .update(`${encodedHeader}.${encodedPayload}`)
    .digest('base64')
    .replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/g,'');
  return `${encodedHeader}.${encodedPayload}.${signature}`;
}

function createLiveKitJoinToken({ roomName, identity, name = identity, ttlSeconds = 3600, canPublish = true, canSubscribe = true, canPublishData = true, hidden = false, metadata = '' }) {
  if (!LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) throw new Error('LIVEKIT credentials not configured');
  const now = Math.floor(Date.now() / 1000);
  return createJwtHS256({
    iss: LIVEKIT_API_KEY, sub: identity, name, metadata,
    nbf: now - 10, exp: now + ttlSeconds,
    video: { room: roomName, roomJoin: true, canPublish, canSubscribe, canPublishData, hidden },
  }, LIVEKIT_API_SECRET);
}

function formatTimestamp(seconds) {
  const totalSeconds = Number(seconds) || 0;
  const mins = Math.floor(totalSeconds / 60).toString().padStart(2, '0');
  const secs = (totalSeconds % 60).toFixed(2).padStart(5, '0');
  return `${mins}:${secs}`;
}

async function readJsonResponseSafe(response) {
  const rawText = await response.text();
  try { return { data: rawText ? JSON.parse(rawText) : {}, rawText }; }
  catch { return { data: {}, rawText }; }
}

function extractSarvamErrorMessage(payload, rawText = '') {
  return payload?.message || payload?.error || payload?.detail || payload?.error_message || payload?.errors?.[0]?.message || rawText || 'Sarvam transcription failed';
}

function extractProviderErrorMessage(payload, fallback = 'Request failed') {
  if (!payload) return fallback;
  if (typeof payload === 'string') return payload;
  if (typeof payload?.error === 'string') return payload.error;
  if (typeof payload?.message === 'string') return payload.message;
  if (typeof payload?.detail === 'string') return payload.detail;
  try { return JSON.stringify(payload); } catch { return fallback; }
}

function extractJsonObject(text) {
  try { return JSON.parse(text); }
  catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end === -1) throw new Error('No JSON object found in model response');
    return JSON.parse(text.slice(start, end + 1));
  }
}

function parseCanonicalYesNo(text) {
  const normalized = String(text || '').trim().toLowerCase();
  if (!normalized) return null;
  const yesValues = new Set(['yes','y','yeah','yep','true','haan','ha','han','ho','hoy','hoi','हाँ','हां','हो','होय']);
  const noValues = new Set(['no','n','nope','nah','false','nahi','naahi','नहीं','नही','नाही']);
  if (yesValues.has(normalized) || /^(yes|haan|ha|ho|hoy|hoi)\b/.test(normalized)) return 'Yes';
  if (noValues.has(normalized) || /^(no|nahi|naahi)\b/.test(normalized)) return 'No';
  return null;
}

function normalizeIndicSpeechText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/ऑक्टोबर|अक्टूबर|ऑक्टूबर/gi,' october ')
    .replace(/सप्टेंबर|सितंबर|सितम्बर/gi,' september ')
    .replace(/नवंबर|नोव्हेंबर/gi,' november ')
    .replace(/डिसेंबर|दिसंबर/gi,' december ')
    .replace(/शून्य|सुन्य|सु्न्य/gi,' zero ')
    .replace(/एक/gi,' one ').replace(/दोन|दो/gi,' two ').replace(/तीन/gi,' three ')
    .replace(/चार/gi,' four ').replace(/पाच/gi,' five ').replace(/सहा|छह/gi,' six ')
    .replace(/सात/gi,' seven ').replace(/आठ/gi,' eight ').replace(/नऊ|नौ/gi,' nine ')
    .replace(/दहा|दस/gi,' ten ').replace(/हजार/gi,' thousand ')
    .replace(/\bek\b/gi,' one ').replace(/\bdon\b|\bdo\b/gi,' two ')
    .replace(/\bteen\b|\btheen\b|\btin\b/gi,' three ')
    .replace(/\bchar\b|\bchaar\b/gi,' four ')
    .replace(/\bpach\b|\bpanch\b|\bpaanch\b/gi,' five ')
    .replace(/\bsaha\b|\bchhe\b|\bcheh\b/gi,' six ')
    .replace(/\bsaat\b|\bsat\b/gi,' seven ')
    .replace(/\baath\b|\bath\b/gi,' eight ')
    .replace(/\bnau\b|\bnav\b/gi,' nine ')
    .replace(/\bdaha\b|\bdas\b/gi,' ten ')
    .replace(/\bshe\b|\bshay\b/gi,' hundred ')
    .replace(/\bhajar\b|\bhazaar\b|\bhazar\b/gi,' thousand ')
    .replace(/\blakh\b|\blac\b/gi,' lakh ')
    .replace(/\s+/g,' ').trim();
}

async function localizeKycText(text, languageCode) {
  const trimmed = String(text || '').trim();
  if (!trimmed || !languageCode || languageCode === 'en') return trimmed;
  const languageName = getKycLanguageName(languageCode);
  const completion = await trackOpenAICall(`KYC localize ${languageCode}`, () =>
    openai.chat.completions.create({
      model: 'gpt-4o-mini', temperature: 0.1,
      messages: [
        { role: 'system', content: `Translate to ${languageName}. Return only the translated text. Keep tone warm and direct. Preserve names, numbers, dates.` },
        { role: 'user', content: trimmed },
      ],
    })
  );
  return completion.choices[0]?.message?.content?.trim() || trimmed;
}

async function normalizeKycAnswer({ text, preferredLanguage, currentFieldLabel, currentFieldType, currentFieldSection }) {
  const fieldLabel = String(currentFieldLabel || '').trim();
  const fieldType = String(currentFieldType || '').trim() || 'text';
  const normalizedLabel = fieldLabel.toLowerCase();
  const trimmed = String(text || '').trim();
  if (!trimmed) return { englishText: '', canonicalYesNo: null };

  const normalizedInput = normalizeIndicSpeechText(trimmed);
  const directYesNo = parseCanonicalYesNo(trimmed) || parseCanonicalYesNo(normalizedInput);
  if (fieldType === 'yes_no' && directYesNo) return { englishText: directYesNo, canonicalYesNo: directYesNo };

  const isStructuredField = fieldType === 'yes_no' || fieldType === 'date' || fieldType === 'number' || normalizedLabel.includes('date of birth') || normalizedLabel.includes('contact') || normalizedLabel.includes('gender');
  if (isStructuredField) return { englishText: directYesNo || trimmed, canonicalYesNo: fieldType === 'yes_no' ? directYesNo : null };
  if (!preferredLanguage || preferredLanguage === 'en') return { englishText: trimmed, canonicalYesNo: fieldType === 'yes_no' ? directYesNo : null };

  const languageName = getKycLanguageName(preferredLanguage);
  const completion = await trackOpenAICall(`KYC normalize ${preferredLanguage}`, () =>
    openai.chat.completions.create({
      model: 'gpt-4o-mini', temperature: 0,
      messages: [
        { role: 'system', content: `Normalize patient answer for KYC PDF. Return ONLY valid JSON: {"englishText":"English value","canonicalYesNo":"Yes"|"No"|null}. Translate from ${languageName} into concise English.` },
        { role: 'user', content: JSON.stringify({ fieldLabel: currentFieldLabel || '', fieldType: currentFieldType || 'text', fieldSection: currentFieldSection || '', selectedLanguage: languageName, answer: trimmed }) },
      ],
    })
  );
  const parsed = extractJsonObject(completion.choices[0]?.message?.content || '{}');
  const canonicalYesNo = parsed.canonicalYesNo === 'Yes' || parsed.canonicalYesNo === 'No' ? parsed.canonicalYesNo : null;
  return { englishText: String(parsed.englishText || '').trim() || trimmed, canonicalYesNo };
}

async function generateTTS(text) {
  const speech = await openai.audio.speech.create({
    model: 'gpt-4o-mini-tts', voice: 'shimmer', input: text,
    instructions: DOCTOR_TTS_INSTRUCTIONS, speed: DOCTOR_TTS_SPEED,
  });
  const buffer = Buffer.from(await speech.arrayBuffer());
  return buffer.toString('base64');
}

/* ===================== Routes ===================== */

app.get('/api/health', (req, res) => res.status(200).json({ status: 'ok', timestamp: Date.now() }));

app.post('/api/analyze', async (req, res) => {
  try {
    const { messages } = req.body;
    if (!Array.isArray(messages)) return res.status(400).json({ error: 'Invalid messages payload' });
    const completion = await trackOpenAICall('chat.completions /api/analyze', () =>
      openai.chat.completions.create({ model: 'gpt-4o-mini', temperature: 0.3, messages })
    );
    res.json({ content: completion.choices[0]?.message?.content || '' });
  } catch (err) {
    console.error('ANALYZE ERROR:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/voice', upload.single('audio'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No audio file provided' });
    const filePath = req.file.path;
    const dischargeSummary = req.body.dischargeSummary || '';
    const stats = fs.statSync(filePath);
    if (stats.size < 1000) {
      fs.unlinkSync(filePath);
      return res.json({ transcription: '', responseText: "I didn't catch that. Please try speaking a bit longer.", audioBase64: null, alert: false });
    }
    const transcription = await trackOpenAICall('audio.transcriptions /api/voice', () =>
      openai.audio.transcriptions.create({ file: fs.createReadStream(filePath), model: 'whisper-1' })
    );
    const spokenText = transcription.text?.trim();
    if (!spokenText) {
      return res.json({ transcription: '', responseText: 'I could not hear you clearly. Please try again.', audioBase64: null, alert: false });
    }
    const isHindi = /[ऀ-ॿ]/.test(spokenText);
    const escalationTriggers = ['severe pain','chest pain','shortness of breath','bleeding','बहुत दर्द','सांस नहीं','खून'];
    const needsNurse = escalationTriggers.some(t => spokenText.toLowerCase().includes(t));
    let aiResponseText;
    if (needsNurse) {
      aiResponseText = isHindi ? 'मैं अभी एक अलर्ट बना रहा हूँ।' : 'I am creating an alert now so you can speak with a nurse directly.';
    } else {
      const chat = await trackOpenAICall('chat.completions /api/voice', () =>
        openai.chat.completions.create({
          model: 'gpt-4o-mini', temperature: 0.3,
          messages: [
            { role: 'system', content: 'You are a patient follow-up voice assistant. Ask one gentle follow-up question.' },
            { role: 'system', content: `Discharge Summary:\n${dischargeSummary || 'Not provided'}` },
            { role: 'user', content: spokenText },
          ],
        })
      );
      aiResponseText = chat.choices[0]?.message?.content;
    }
    const speech = await trackOpenAICall('audio.speech /api/voice', () =>
      openai.audio.speech.create({ model: 'gpt-4o-mini-tts', voice: 'shimmer', input: aiResponseText, instructions: DOCTOR_TTS_INSTRUCTIONS, speed: DOCTOR_TTS_SPEED })
    );
    const audioBuffer = Buffer.from(await speech.arrayBuffer());
    fs.unlinkSync(filePath);
    res.json({ transcription: spokenText, responseText: aiResponseText, audioBase64: audioBuffer.toString('base64'), alert: needsNurse, language: isHindi ? 'hi' : 'en' });
  } catch (err) {
    console.error('VOICE API ERROR:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/tts', async (req, res) => {
  try {
    const { text } = req.body;
    if (!text) return res.status(400).json({ error: 'Text is required' });
    const speech = await trackOpenAICall('audio.speech /api/tts', () =>
      openai.audio.speech.create({ model: 'gpt-4o-mini-tts', voice: 'shimmer', input: text, instructions: DOCTOR_TTS_INSTRUCTIONS, speed: DOCTOR_TTS_SPEED })
    );
    const audioBuffer = Buffer.from(await speech.arrayBuffer());
    res.json({ audioBase64: audioBuffer.toString('base64') });
  } catch (err) {
    console.error('TTS ERROR:', err);
    res.status(500).json({ error: 'TTS failed' });
  }
});

app.post('/api/kyc/localize-text', async (req, res) => {
  try {
    const { text, languageCode } = req.body;
    if (!text || typeof text !== 'string') return res.status(400).json({ error: 'Text is required' });
    const localizedText = await localizeKycText(text, (languageCode || 'en').trim().toLowerCase());
    res.json({ text: localizedText });
  } catch (err) {
    console.error('KYC LOCALIZE ERROR:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/kyc/normalize-answer', async (req, res) => {
  try {
    const { text, preferredLanguage, currentFieldLabel, currentFieldType, currentFieldSection } = req.body;
    if (!text || typeof text !== 'string') return res.status(400).json({ error: 'Text is required' });
    const result = await normalizeKycAnswer({
      text, preferredLanguage: (preferredLanguage || 'en').trim().toLowerCase(),
      currentFieldLabel, currentFieldType, currentFieldSection,
    });
    res.json(result);
  } catch (err) {
    console.error('KYC NORMALIZE ERROR:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/kyc/conversational-response', async (req, res) => {
  try {
    const { userAnswer, currentField, nextField, fieldIndex, totalFields, previousResponses, isComplete, preferredLanguage } = req.body;
    const languageName = getKycLanguageName(preferredLanguage || 'en');
    const systemPrompt = `You are a warm, professional female doctor helping a patient fill out their KYC medical form. Respond in ${languageName}. Keep responses SHORT - under 40 words. Acknowledge the answer naturally, then ask the next question conversationally.`;
    const completion = await trackOpenAICall('KYC conversational response', () =>
      openai.chat.completions.create({
        model: 'gpt-4o-mini', temperature: 0.7, max_tokens: 150,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: JSON.stringify({ userAnswer, currentFieldLabel: currentField?.label, nextFieldLabel: nextField?.label || null, fieldIndex, totalFields, isComplete }) },
        ],
      })
    );
    res.json({ text: completion.choices[0]?.message?.content?.trim() || '' });
  } catch (err) {
    console.error('KYC CONVERSATIONAL ERROR:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/kyc/preloaded-document', async (req, res) => {
  try {
    const candidatePaths = [
      DEFAULT_KYC_PDF_PATH,
      path.resolve(process.cwd(), '../kyc-templates/default-kyc.pdf'),
      path.resolve(process.cwd(), './kyc-templates/default-kyc.pdf'),
    ];
    const resolvedPdfPath = candidatePaths.find(p => fs.existsSync(p));
    if (!resolvedPdfPath) return res.status(404).json({ error: 'No default KYC document configured' });
    const pdfBuffer = fs.readFileSync(resolvedPdfPath);
    res.json({ fileName: path.basename(resolvedPdfPath), pdfBase64: pdfBuffer.toString('base64') });
  } catch (err) {
    console.error('PRELOADED DOC ERROR:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/kyc/extract-fields', async (req, res) => {
  try {
    const { text } = req.body;
    if (!text || typeof text !== 'string') return res.status(400).json({ error: 'Missing text' });
    const completion = await trackOpenAICall('KYC extract fields', () =>
      openai.chat.completions.create({
        model: 'gpt-4o-mini', temperature: 0.1,
        messages: [
          { role: 'system', content: `Extract KYC form fields. Return ONLY valid JSON: {"fields":[{"id":"camelCase","label":"exact label","type":"text|yes_no|select|number|date|checkbox_group","section":"section name","genderRestriction":"all|male|female"}]}` },
          { role: 'user', content: text.slice(0, 30000) },
        ],
      })
    );
    res.json({ content: completion.choices[0]?.message?.content || '' });
  } catch (err) {
    console.error('KYC EXTRACT ERROR:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/kyc/transcribe', upload.single('audio'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No audio file' });
    const filePath = req.file.path;
    const preferredLanguage = (req.body.preferredLanguage || '').trim().toLowerCase();
    const currentFieldLabel = (req.body.currentFieldLabel || '').trim();
    const currentFieldType = (req.body.currentFieldType || 'text').trim().toLowerCase();
    const currentFieldSection = (req.body.currentFieldSection || '').trim();
    const transcriptionConfig = {
      file: fs.createReadStream(filePath), model: 'whisper-1', temperature: 0,
      prompt: `KYC intake. Field: ${currentFieldLabel}`.slice(0, 800),
    };
    if (preferredLanguage) transcriptionConfig.language = preferredLanguage;
    const transcription = await trackOpenAICall('KYC transcribe', () => openai.audio.transcriptions.create(transcriptionConfig));
    const transcriptText = transcription.text?.trim() || '';
    const normalized = await normalizeKycAnswer({ text: transcriptText, preferredLanguage: preferredLanguage || 'en', currentFieldLabel, currentFieldType, currentFieldSection });
    fs.unlinkSync(filePath);
    res.json({ text: transcriptText, englishText: normalized.englishText, canonicalYesNo: normalized.canonicalYesNo });
  } catch (err) {
    console.error('KYC TRANSCRIBE ERROR:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/sarvam/transcribe', upload.single('audio'), async (req, res) => {
  const filePath = req.file?.path;
  try {
    if (!req.file) return res.status(400).json({ error: 'No audio file provided' });
    const sarvamApiKey = process.env.SARVAM_API_KEY;
    if (!sarvamApiKey) {
      if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
      return res.status(500).json({ error: 'SARVAM_API_KEY not configured' });
    }
    const FormData = (await import('form-data')).default;
    const form = new FormData();
    form.append('file', fs.createReadStream(filePath));
    form.append('model', 'saaras:v3');
    form.append('mode', 'transcribe');
    form.append('with_timestamps', 'true');
    form.append('language_code', String(req.body.language || 'en-IN').trim());
    const sarvamRes = await fetch('https://api.sarvam.ai/speech-to-text', {
      method: 'POST',
      headers: { 'API-Subscription-Key': sarvamApiKey, ...form.getHeaders() },
      body: form,
    });
    const { data: sarvamData, rawText } = await readJsonResponseSafe(sarvamRes);
    if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
    if (!sarvamRes.ok) return res.status(sarvamRes.status).json({ error: extractSarvamErrorMessage(sarvamData, rawText) });
    const diarizedEntries = sarvamData?.diarized_transcript?.entries || [];
    const segments = diarizedEntries.length > 0 ? diarizedEntries : sarvamData.segments || sarvamData.utterances || [];
    const formatted = segments.map(seg => {
      const start = formatTimestamp(seg.start || seg.start_time || 0);
      const end = formatTimestamp(seg.end || seg.end_time || 0);
      const speaker = seg.speaker || seg.speaker_id || 'Speaker';
      const text = (seg.text || seg.transcript || '').trim();
      if (!text) return null;
      return `[${start} → ${end}] ${speaker}:\n${text}`;
    }).filter(Boolean).join('\n\n');
    res.json({ raw: sarvamData, formatted: formatted || sarvamData.transcript || 'No transcript available' });
  } catch (err) {
    if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
    console.error('SARVAM TRANSCRIBE ERROR:', err);
    res.status(500).json({ error: err.message });
  }
});

/* =====================
   /api/beyondpresence/start-session
   
   NOW uses LiveKit Agent worker pattern:
   1. Create a unique room name
   2. Set room metadata with KYC system prompt + greeting
   3. The LiveKit Agent (agent.js) auto-picks up the room and connects the BP avatar
   4. Return LiveKit URL + patient token to frontend
===================== */
app.post('/api/beyondpresence/start-session', async (req, res) => {
  try {
    if (!LIVEKIT_URL || !LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) {
      return res.status(500).json({
        error: 'LIVEKIT_URL, LIVEKIT_API_KEY, and LIVEKIT_API_SECRET must be configured.',
        code: 'livekit_not_configured',
        retryable: false,
      });
    }

    const { kycFields = [], openingPrompt = '', language = 'en', preferredLanguage = 'en' } = req.body || {};

    const languageName = getKycLanguageName(preferredLanguage);
    const providerLanguage = getBeyondPresenceLanguageCode(String(language || preferredLanguage || 'en').trim());

    // Build field list for the agent system prompt
    const fieldListBase = kycFields.map((f, i) => {
      const genderTag = f.genderRestriction && f.genderRestriction !== 'all' ? ` [${f.genderRestriction.toUpperCase()} ONLY]` : '';
      return `${i + 1}. ${f.prompt || f.label}${genderTag}`;
    }).join('\n');

    const fieldListText = preferredLanguage && preferredLanguage !== 'en'
      ? await localizeKycText(fieldListBase, preferredLanguage)
      : fieldListBase;

    const firstFieldPrompt = String(openingPrompt || '').trim() || kycFields[0]?.prompt || `What is your ${String(kycFields[0]?.label || 'application number').toLowerCase()}?`;
    const baseGreetingText = `Hi, my name is Dr. Christiana. Let's get started with your medical examination report. ${firstFieldPrompt}`;
    const greetingText = preferredLanguage && preferredLanguage !== 'en'
      ? await localizeKycText(baseGreetingText, preferredLanguage)
      : baseGreetingText;

    const speechInstruction = providerLanguage !== String(language || preferredLanguage).trim()
      ? `Speak only in ${languageName} for all patient-facing responses.`
      : `Speak only in ${languageName} for all patient-facing responses.`;

    const kycSystemPrompt = `You are Dr. Christiana, a warm professional doctor helping a patient complete a KYC medical form during a video call.

${speechInstruction} Be empathetic, calm, natural, and brief. Keep each reply under 35 words.

Ask these fields one by one in order:
${fieldListText}

Rules:
- Ask only one field at a time and wait for the answer before moving on.
- If gender is male, skip all [FEMALE ONLY] fields silently. If gender is female, skip all [MALE ONLY] fields silently.
- Use a short acknowledgment, then move directly to the next question.
- For yes/no fields, ask naturally. If the patient says yes without details and details are needed, ask one short follow-up.
- When all fields are done, congratulate the patient warmly and say the form is complete.`;

    // Create LiveKit room + tokens
    const roomName = `carely-kyc-${uuidv4().slice(0, 12)}`;
    const patientIdentity = `patient-${uuidv4().slice(0, 8)}`;
    const conversationId = `s2v_${roomName}_${Date.now()}`;

    // ✅ Step A: Create the room with metadata so agent can read systemPrompt + greeting
    const roomService = new RoomServiceClient(LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET);
    await roomService.createRoom({
      name: roomName,
      metadata: JSON.stringify({
        systemPrompt: kycSystemPrompt,
        greeting: greetingText,
        language: providerLanguage,
      }),
      emptyTimeout: 300,   // auto-delete room after 5 min if empty
      maxParticipants: 5,
    });
    console.log(`[S2V] Room created: ${roomName}`);

    // ✅ Step B: Dispatch the agent worker to this room
    const dispatchClient = new AgentDispatchClient(LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET);
    await dispatchClient.createDispatch(roomName, 'carely-agent');
    console.log(`[S2V] Agent dispatched to room: ${roomName}`);
    console.log("🔥 TOKEN API HIT", new Date().toISOString());

    const patientToken = createLiveKitJoinToken({
      roomName,
      identity: patientIdentity,
      name: 'Patient',
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
      // Pass metadata so the agent can read it when it joins
      metadata: JSON.stringify({ role: 'patient' }),
    });

    // Store session state (for process-speech fallback and stop-session)
    s2vSessions.set(conversationId, {
      createdAt: Date.now(),
      roomName,
      patientIdentity,
      preferredLanguage,
      languageName,
      kycSystemPrompt,
      greetingText,
      fields: kycFields,
      currentStep: 0,
      answers: {},
    });

    // Generate greeting TTS for immediate playback while agent connects
    let greetingAudioBase64 = null;
    try {
      greetingAudioBase64 = await generateTTS(greetingText);
    } catch (err) {
      console.warn('[S2V] Greeting TTS failed:', err.message);
    }

    console.log(`[S2V] Room created: ${roomName}, conversationId: ${conversationId}`);
    console.log(`[S2V] Agent will auto-dispatch to room via LiveKit agent worker`);

    res.json({
      sessionId: roomName,
      callId: roomName,
      conversationId,
      livekitUrl: LIVEKIT_URL,
      livekitToken: patientToken,
      greetingText,
      greetingAudioBase64,
      mode: 'speech_to_video',
    });
  } catch (err) {
    console.error('S2V START ERROR:', err);
    res.status(500).json({ error: err.message, retryable: false });
  }
});

app.post('/api/beyondpresence/process-speech', upload.single('audio'), async (req, res) => {
  const filePath = req.file?.path;
  try {
    if (!req.file) return res.status(400).json({ error: 'No audio file provided' });
    const conversationId = String(req.body?.conversationId || '').trim();
    const preferredLanguage = String(req.body?.preferredLanguage || 'en').trim().toLowerCase();
    const session = s2vSessions.get(conversationId);
    if (!session) return res.status(400).json({ error: 'Session not found. Please start session again.' });
    const fields = session.fields || [];
    if (!fields.length) return res.status(400).json({ error: 'No KYC fields found in session' });

    const stats = fs.statSync(filePath);
    if (stats.size < 800) {
      if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
      return res.json({ transcript: '', responseText: '', audioBase64: null, conversationId, skipped: true });
    }

    const transcriptionConfig = { file: fs.createReadStream(filePath), model: 'whisper-1', temperature: 0 };
    if (preferredLanguage && preferredLanguage !== 'en') transcriptionConfig.language = preferredLanguage;
    const transcription = await trackOpenAICall('S2V Whisper ASR', () => openai.audio.transcriptions.create(transcriptionConfig));
    const transcript = String(transcription.text || '').trim();
    if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
    if (!transcript) return res.json({ transcript: '', responseText: '', audioBase64: null, conversationId, skipped: true });

    const currentField = fields[session.currentStep];
    if (currentField) {
      session.answers[currentField.id] = transcript;
    }
    session.currentStep++;

    if (session.currentStep >= fields.length) {
      const doneText = 'Thank you. Your KYC is complete.';
      return res.json({ transcript, responseText: doneText, audioBase64: await generateTTS(doneText), conversationId });
    }

    const nextField = fields[session.currentStep];
    const nextQuestion = nextField?.prompt || nextField?.label || 'Please continue';
    return res.json({ transcript, responseText: nextQuestion, audioBase64: await generateTTS(nextQuestion), conversationId });
  } catch (err) {
    if (filePath && fs.existsSync(filePath)) { try { fs.unlinkSync(filePath); } catch { } }
    console.error('S2V PROCESS-SPEECH ERROR:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/beyondpresence/send-greeting', async (req, res) => {
  try {
    const { conversationId } = req.body || {};
    const session = s2vSessions.get(conversationId);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    if (!session.greetingText) return res.json({ text: '', audioBase64: null });
    const audioBase64 = await generateTTS(session.greetingText);
    res.json({ text: session.greetingText, audioBase64 });
  } catch (err) {
    console.error('S2V GREETING ERROR:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/beyondpresence/stop-session', async (req, res) => {
  try {
    const { sessionId, callId, conversationId, agentId } = req.body || {};
    if (agentId && BEY_API_KEY) {
      await fetch(`${BEY_API_BASE}/v1/agents/${agentId}`, { method: 'DELETE', headers: { 'x-api-key': BEY_API_KEY } }).catch(err => console.warn('[BeyondPresence] Agent cleanup failed:', err));
    }
    if (conversationId) s2vSessions.delete(conversationId);
    res.json({ success: true });
  } catch (err) {
    console.error('BEYOND PRESENCE STOP ERROR:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/beyondpresence/call-messages/:callId', async (req, res) => {
  try {
    if (!BEY_API_KEY) return res.status(500).json({ error: 'BEYOND_PRESENCE_API_KEY not configured' });
    const messagesRes = await fetch(`${BEY_API_BASE}/v1/calls/${req.params.callId}/messages`, { headers: { 'x-api-key': BEY_API_KEY } });
    const messagesData = await messagesRes.json();
    res.json(messagesData);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/beyondpresence/agent-call-messages/:agentId', async (req, res) => {
  try {
    if (!BEY_API_KEY) return res.status(500).json({ error: 'BEYOND_PRESENCE_API_KEY not configured' });
    const callsRes = await fetch(`${BEY_API_BASE}/v1/calls?limit=50`, { headers: { 'x-api-key': BEY_API_KEY } });
    const callsData = await callsRes.json();
    if (!callsRes.ok) return res.status(callsRes.status || 500).json({ error: extractProviderErrorMessage(callsData) });
    const calls = Array.isArray(callsData?.data) ? callsData.data : [];
    const latestCall = calls.filter(call => call.agent_id === req.params.agentId).sort((a, b) => new Date(b.started_at || 0) - new Date(a.started_at || 0))[0];
    if (!latestCall?.id) return res.json({ callId: null, messages: [], call: null });
    const messagesRes = await fetch(`${BEY_API_BASE}/v1/calls/${latestCall.id}/messages`, { headers: { 'x-api-key': BEY_API_KEY } });
    const messagesData = await messagesRes.json();
    if (!messagesRes.ok) return res.status(messagesRes.status || 500).json({ error: extractProviderErrorMessage(messagesData) });
    res.json({ callId: latestCall.id, call: latestCall, messages: Array.isArray(messagesData) ? messagesData : [] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/discharge/intro', async (req, res) => {
  try {
    const { dischargeSummary } = req.body || {};
    if (!dischargeSummary) return res.json({ introText: 'Discharge summary uploaded.' });
    const completion = await trackOpenAICall('discharge intro', () =>
      openai.chat.completions.create({
        model: 'gpt-4o-mini', temperature: 0.3, max_tokens: 150,
        messages: [
          { role: 'system', content: 'Briefly acknowledge the discharge summary in 2-3 sentences, mention the main condition if visible, and offer to help. Be warm and concise.' },
          { role: 'user', content: dischargeSummary.slice(0, 2000) },
        ],
      })
    );
    res.json({ introText: completion.choices[0]?.message?.content?.trim() || 'Discharge summary received.' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/livekit-token', (req, res) => {
  try {
    const roomName = 'kyc-room';
    const identity = 'user-' + Date.now();
    const token = createLiveKitJoinToken({ roomName, identity });
    res.json({ token, livekitUrl: LIVEKIT_URL, roomName });
  } catch (err) {
    console.error('Token error:', err);
    res.status(500).json({ error: 'Failed to create token' });
  }
});

/* ===================== PAN card routes ===================== */
app.post('/api/pan/create-session', async (req, res) => {
  try {
    const sessionId = uuidv4().slice(0, 12);
    const localIP = getLocalIP();
    const mobileUrl = `http://${localIP}:3001/pan-capture/${sessionId}`;
    const qrDataUrl = await QRCode.toDataURL(mobileUrl, { width: 280, margin: 2, color: { dark: '#1e293b', light: '#ffffff' } });
    panSessions.set(sessionId, { createdAt: Date.now(), status: 'waiting', frontBase64: null, backBase64: null, frontMime: null, backMime: null, ocrResult: null });
    res.json({ sessionId, qrCodeDataUrl: qrDataUrl, mobileUrl, localIP });
  } catch (err) {
    console.error('PAN CREATE SESSION ERROR:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/pan/status/:sessionId', (req, res) => {
  const session = panSessions.get(req.params.sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found or expired' });
  res.json({ status: session.status, hasFront: !!session.frontBase64, hasBack: !!session.backBase64, ocrResult: session.ocrResult });
});

async function handlePanUpload(sessionId, files) {
  const session = panSessions.get(sessionId);
  if (!session) throw new Error('Session not found or expired');
  const frontFile = files?.front?.[0];
  const backFile = files?.back?.[0];
  if (frontFile) { session.frontBase64 = frontFile.buffer.toString('base64'); session.frontMime = frontFile.mimetype; }
  if (backFile) { session.backBase64 = backFile.buffer.toString('base64'); session.backMime = backFile.mimetype; }
  if (session.frontBase64 && session.backBase64) session.status = 'complete';
  else if (frontFile) session.status = 'front_uploaded';
  else if (backFile) session.status = 'back_uploaded';
  if (session.status === 'complete' && !session.ocrResult) {
    try { session.ocrResult = await extractPanCardDetails(session.frontBase64, session.frontMime || 'image/jpeg'); }
    catch (ocrErr) { console.warn('PAN OCR failed:', ocrErr.message); session.ocrResult = { error: ocrErr.message }; }
  }
  return { status: session.status, ocrResult: session.ocrResult };
}

const panUploadFields = panUpload.fields([{ name: 'front', maxCount: 1 }, { name: 'back', maxCount: 1 }]);
app.post('/api/pan/upload/:sessionId', panUploadFields, async (req, res) => {
  try { res.json(await handlePanUpload(req.params.sessionId, req.files)); }
  catch (err) { res.status(err.message === 'Session not found or expired' ? 404 : 500).json({ error: err.message }); }
});
app.post('/api/pan/upload-desktop/:sessionId', panUploadFields, async (req, res) => {
  try { res.json(await handlePanUpload(req.params.sessionId, req.files)); }
  catch (err) { res.status(err.message === 'Session not found or expired' ? 404 : 500).json({ error: err.message }); }
});

async function extractPanCardDetails(frontBase64, mimeType = 'image/jpeg') {
  const completion = await trackOpenAICall('PAN OCR', () =>
    openai.chat.completions.create({
      model: 'gpt-4o', temperature: 0, max_tokens: 500,
      messages: [
        { role: 'system', content: `Extract PAN card fields. Return ONLY valid JSON: {"panNumber":"ABCDE1234F","fullName":"name","fatherName":"name","dateOfBirth":"DD/MM/YYYY","cardType":"Individual"}. Set null if unreadable.` },
        { role: 'user', content: [{ type: 'image_url', image_url: { url: `data:${mimeType};base64,${frontBase64}` } }, { type: 'text', text: 'Extract PAN card details.' }] },
      ],
    })
  );
  return extractJsonObject(completion.choices[0]?.message?.content || '{}');
}

app.get('/pan-capture/:sessionId', (req, res) => {
  const session = panSessions.get(req.params.sessionId);
  if (!session) return res.status(404).send('<h1>Session expired or not found</h1>');
  res.type('html').send(`<!DOCTYPE html><html><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/><title>PAN Card Capture</title><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:sans-serif;background:#0f172a;color:#e2e8f0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}.wrap{width:100%;max-width:520px;background:#111827;border:1px solid rgba(255,255,255,0.08);border-radius:20px;padding:24px}h1{font-size:24px;margin-bottom:8px;text-align:center}p{color:#94a3b8;font-size:14px;line-height:1.5;text-align:center}.grid{display:grid;gap:16px;margin-top:24px}.card{background:#0b1220;border:2px dashed #334155;border-radius:16px;padding:18px}.label{display:block;font-size:12px;font-weight:700;color:#cbd5e1;margin-bottom:10px;text-transform:uppercase}input[type="file"]{width:100%;color:#e2e8f0}button{width:100%;margin-top:20px;padding:14px;border:none;border-radius:14px;background:linear-gradient(135deg,#8b5cf6,#6d28d9);color:white;font-size:15px;font-weight:700}button:disabled{opacity:0.6}.msg{margin-top:14px;font-size:13px;text-align:center;color:#cbd5e1}.err{color:#fca5a5}</style></head><body><div class="wrap"><h1>Upload PAN Card</h1><p>Please upload the front and back images of the PAN card to continue verification.</p><div class="grid"><div class="card"><label class="label" for="front">Front Side</label><input id="front" type="file" accept="image/*" capture="environment"/></div><div class="card"><label class="label" for="back">Back Side</label><input id="back" type="file" accept="image/*" capture="environment"/></div></div><button id="submitBtn" disabled>Upload Images</button><div id="msg" class="msg"></div></div><script>const f=document.getElementById('front'),b=document.getElementById('back'),btn=document.getElementById('submitBtn'),msg=document.getElementById('msg');const check=()=>{btn.disabled=!(f.files.length&&b.files.length)};f.addEventListener('change',check);b.addEventListener('change',check);btn.addEventListener('click',async()=>{btn.disabled=true;msg.textContent='Uploading...';try{const form=new FormData();form.append('front',f.files[0]);form.append('back',b.files[0]);const res=await fetch('/api/pan/upload/${req.params.sessionId}',{method:'POST',body:form});const data=await res.json();if(!res.ok)throw new Error(data.error||'Upload failed');msg.textContent='PAN card uploaded successfully. You can return to the desktop.';}catch(err){msg.textContent=err.message;msg.className='msg err';btn.disabled=false;}});</script></body></html>`);
});

/* ===================== Start server ===================== */
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});