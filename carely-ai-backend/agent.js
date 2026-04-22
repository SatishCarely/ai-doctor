// import 'dotenv/config';
// import { fileURLToPath } from 'node:url';
// import { WorkerOptions, cli, defineAgent, voice } from '@livekit/agents';
// import { AvatarSession } from '@livekit/agents-plugin-bey';
// import { LLM, STT, TTS } from '@livekit/agents-plugin-openai';

// const BEY_AVATAR_ID = process.env.BEY_AVATAR_ID || 'f30d7eef-6e71-433f-938d-cecdd8c0b653';

// export default defineAgent({
//   entry: async (ctx) => {
//     await ctx.connect();
//     console.log('[Agent] Connected to room:', ctx.room.name);

//     // Read metadata set by server.js RoomServiceClient
//     let systemPrompt = 'You are Dr. Christiana, a warm professional doctor helping a patient complete a KYC medical form. Be empathetic, calm, natural, and brief. Keep each reply under 35 words. Ask one field at a time.';
//     let greeting = "Hi, my name is Dr. Christiana. Let's get started with your medical examination report.";
//     let language = 'en';

//     try {
//       const meta = ctx.room.metadata ? JSON.parse(ctx.room.metadata) : {};
//       if (meta.systemPrompt) systemPrompt = meta.systemPrompt;
//       if (meta.greeting)     greeting     = meta.greeting;
//       if (meta.language)     language     = meta.language;
//       console.log('[Agent] Room metadata loaded ✓');
//     } catch {
//       console.warn('[Agent] Could not parse room metadata — using defaults.');
//     }

//     // ✅ Correct v1.x API — voice.Agent + voice.AgentSession
//     const agent = new voice.Agent({
//       instructions: systemPrompt,
//       stt: new STT({ model: 'whisper-1', language }),
//       llm: new LLM({ model: 'gpt-4o-mini', temperature: 0.7 }),
//       tts: new TTS({ model: 'tts-1', voice: 'shimmer', speed: 0.94 }),
//     });

//     const agentSession = new voice.AgentSession();

//     // ✅ Correct AvatarSession constructor — uses avatarId not beyAvatarId
//     const beyAvatarSession = new AvatarSession({
//       avatarId: BEY_AVATAR_ID,
//       // apiKey and LiveKit creds read from env automatically
//     });

//     // ✅ Start avatar BEFORE agentSession.start() so audio output is configured
//     await beyAvatarSession.start(agentSession, ctx.room);
//     console.log('[Agent] Beyond Presence avatar attached ✓');

//     // ✅ Start the voice pipeline
//     await agentSession.start(ctx.room, agent);
//     console.log('[Agent] Voice pipeline started ✓');

//     // ✅ Send greeting
//     await agentSession.say(greeting, { allowInterruptions: false });
//     console.log('[Agent] Greeting sent ✓');
//   },
// });

// // ✅ No process.argv override — start.js already passes 'dev'
// cli.runApp(new WorkerOptions({
//   agent:     fileURLToPath(import.meta.url),
//   wsURL:     process.env.LIVEKIT_URL,
//   apiKey:    process.env.LIVEKIT_API_KEY,
//   apiSecret: process.env.LIVEKIT_API_SECRET,
// }));

process.env.FFMPEG_PATH = "/usr/bin/ffmpeg";

import 'dotenv/config';
import { fileURLToPath } from 'node:url';
import { WorkerOptions, cli, defineAgent, voice } from '@livekit/agents';
import * as bey    from '@livekit/agents-plugin-bey';
import * as openai from '@livekit/agents-plugin-openai';

// NO silero import — silero requires ffmpeg which crashes in Docker
// Turn detection works without it via OpenAI pipeline

const BEY_AVATAR_ID = process.env.BEY_AVATAR_ID || 'f30d7eef-6e71-433f-938d-cecdd8c0b653';

export default defineAgent({
  entry: async (ctx) => {
    await ctx.connect();
    console.log('[Agent] Connected to room:', ctx.room.name);

    let systemPrompt = 'You are Dr. Christiana, a warm professional doctor helping a patient complete a KYC medical form. Be empathetic, calm, natural, and brief. Keep each reply under 35 words. Ask one field at a time.';
    let greeting     = "Hi, my name is Dr. Christiana. Let's get started with your medical examination report.";
    let language     = 'en';

    try {
      const meta = ctx.room.metadata ? JSON.parse(ctx.room.metadata) : {};
      if (meta.systemPrompt) systemPrompt = meta.systemPrompt;
      if (meta.greeting)     greeting     = meta.greeting;
      if (meta.language)     language     = meta.language;
    } catch {
      console.warn('[Agent] Could not parse room metadata — using defaults.');
    }

    const voiceAgentSession = new voice.AgentSession({
      stt: new openai.STT({ model: 'whisper-1', language }),
      llm: new openai.LLM({ model: 'gpt-4o-mini', temperature: 0.7 }),
      tts: new openai.TTS({ model: 'tts-1', voice: 'shimmer', speed: 0.94 }),
      input: { audio: { autoSubscribe: true } },
      turnDetection: true,
    });

    const voiceAgent       = new voice.Agent({ instructions: systemPrompt });
    const beyAvatarSession = new bey.AvatarSession({ beyAvatarId: BEY_AVATAR_ID });

    await voiceAgentSession.start({ agent: voiceAgent, room: ctx.room });
    console.log('[Agent] Voice pipeline started ✓');

    await beyAvatarSession.start(voiceAgentSession, ctx.room);
    console.log('[Agent] Beyond Presence avatar attached ✓');

    await voiceAgentSession.say(greeting);

    ctx.room.on('dataReceived', async (payload, participant, kind, topic) => {
      try {
        console.log("📡 DATA RECEIVED from:", participant?.identity);
        console.log("📡 TOPIC:", topic);

        const decoded = new TextDecoder().decode(payload);
        console.log("📩 RAW PAYLOAD:", decoded);

        const msg = JSON.parse(decoded);

        if (msg.type === 'ask_question') {
          console.log("🧠 Agent speaking:", msg.text);

          await voiceAgentSession.say(msg.text);
        }
      } catch (e) {
        console.error("❌ Error parsing data message", e);
      }
    });

    console.log('[Agent] Greeting sent ✓');
  },
});

process.argv = [process.argv[0], process.argv[1], 'dev'];
cli.runApp(new WorkerOptions({
  agent:     fileURLToPath(import.meta.url),
  wsURL:     process.env.LIVEKIT_URL,
  apiKey:    process.env.LIVEKIT_API_KEY,
  apiSecret: process.env.LIVEKIT_API_SECRET,
}));