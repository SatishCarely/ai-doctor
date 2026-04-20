import { useCallback, useEffect, useRef, useState } from 'react';
import { Room, RoomEvent, Track } from 'livekit-client';
import {
  LiveKitRoom,
  RoomAudioRenderer,
  VideoTrack,
  useTracks,
} from '@livekit/components-react';

// ─── VAD / recording constants (from your fixes) ──────────────────────────────
const SILENCE_THRESHOLD = 0.015;
const SILENCE_DURATION_MS = 1400;
const MIN_SPEECH_DURATION_MS = 400;
const AUDIO_SAMPLE_INTERVAL_MS = 80;
const MAX_RECORDING_MS = 30000;
const POST_TTS_LOCKOUT_MS = 1500;

// ─── Avatar video component (uses LiveKit hooks inside LiveKitRoom context) ───
const AvatarVideo = ({ videoRef }) => {
  const tracks = useTracks([{ source: Track.Source.Camera }]);

  const agentTrack = tracks.find(
    (t) => t.participant?.identity?.includes('agent')
  );

  // Mount/unmount into the caller's videoRef div for layout compatibility
  useEffect(() => {
    if (!agentTrack || !videoRef?.current) return;
    videoRef.current.innerHTML = '';
  }, [agentTrack, videoRef]);

  if (!agentTrack) return null;

  return (
    <VideoTrack
      trackRef={agentTrack}
      style={{
        width: '100%',
        height: '100%',
        objectFit: 'cover',
        borderRadius: 0,
        display: 'block',
      }}
    />
  );
};

// ─── Inner component (all your original logic lives here) ────────────────────
function BeyondPresenceInner({
  livekitUrl,
  livekitToken,
  onUserTranscription,
  onAgentTranscription,
  onConnected,
  onDisconnected,
  onRoomRef,
  onSpeakingChange,
  onListeningChange,
  isMuted = false,
  apiBase,
  callId,
  conversationId,
  preferredLanguage,
  initialGreetingAudioBase64,
}) {
  const videoRef = useRef(null);
  const roomRef = useRef(null);
  const audioElementsRef = useRef([]);
  const callbacksRef = useRef({});

  const [connected, setConnected] = useState(false);
  const [error, setError] = useState(null);
  const [speaking, setSpeaking] = useState(false);
  const [listening, setListening] = useState(false);
  const [processing, setProcessing] = useState(false);

  const micStreamRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  const audioContextRef = useRef(null);
  const analyserRef = useRef(null);
  const audioChunksRef = useRef([]);
  const vadTimerRef = useRef(null);
  const speechStartTimeRef = useRef(null);
  const isSpeechActiveRef = useRef(false);
  const isProcessingRef = useRef(false);
  const maxRecordingTimerRef = useRef(null);
  const ttsAudioRef = useRef(null);
  const publishedTrackRef = useRef(null);
  const conversationIdRef = useRef(conversationId || null);
  const initialGreetingPlayedRef = useRef(false);
  const isMutedRef = useRef(isMuted);

  const API_BASE_URL = 'https://3jpvg3rp62.ap-south-1.awsapprunner.com';

  useEffect(() => {
    callbacksRef.current = {
      onUserTranscription, onAgentTranscription,
      onConnected, onDisconnected, onRoomRef,
      onSpeakingChange, onListeningChange,
    };
  });

  useEffect(() => { conversationIdRef.current = conversationId || null; }, [conversationId]);
  useEffect(() => { isMutedRef.current = isMuted; }, [isMuted]);
  useEffect(() => { callbacksRef.current.onSpeakingChange?.(speaking); }, [speaking]);
  useEffect(() => { callbacksRef.current.onListeningChange?.(listening); }, [listening]);

  const setSpeakingState = useCallback((v) => { setSpeaking(v); callbacksRef.current.onSpeakingChange?.(v); }, []);
  const setListeningState = useCallback((v) => { setListening(v); callbacksRef.current.onListeningChange?.(v); }, []);

  const stopVADListening = useCallback(() => {
    clearTimeout(vadTimerRef.current);
    vadTimerRef.current = null;
    setListeningState(false);
  }, [setListeningState]);

  const startVADListening = useCallback(() => {
    const analyser = analyserRef.current;
    if (!analyser || !micStreamRef.current || isMutedRef.current) return;
    clearTimeout(vadTimerRef.current);
    setListeningState(true);

    const bufferLength = analyser.fftSize;
    const dataArray = new Float32Array(bufferLength);
    let silenceStart = null;

    const checkAudio = () => {
      if (!analyserRef.current || isMutedRef.current || isProcessingRef.current) return;
      analyser.getFloatTimeDomainData(dataArray);
      let sum = 0;
      for (let i = 0; i < bufferLength; i += 1) sum += dataArray[i] * dataArray[i];
      const rms = Math.sqrt(sum / bufferLength);
      const isSpeech = rms > SILENCE_THRESHOLD;

      if (isSpeech) {
        silenceStart = null;
        if (!isSpeechActiveRef.current) {
          isSpeechActiveRef.current = true;
          speechStartTimeRef.current = Date.now();
          audioChunksRef.current = [];
          if (mediaRecorderRef.current?.state === 'inactive') {
            try { mediaRecorderRef.current.start(); } catch { /* noop */ }
          }
          clearTimeout(maxRecordingTimerRef.current);
          maxRecordingTimerRef.current = setTimeout(() => {
            if (isSpeechActiveRef.current) {
              const r = mediaRecorderRef.current;
              if (r && r.state !== 'inactive') r.stop();
            }
          }, MAX_RECORDING_MS);
        }
      } else if (isSpeechActiveRef.current) {
        if (!silenceStart) silenceStart = Date.now();
        else if (Date.now() - silenceStart >= SILENCE_DURATION_MS) {
          const r = mediaRecorderRef.current;
          if (r && r.state !== 'inactive') r.stop();
          silenceStart = null;
        }
      }
      vadTimerRef.current = window.setTimeout(checkAudio, AUDIO_SAMPLE_INTERVAL_MS);
    };
    vadTimerRef.current = window.setTimeout(checkAudio, AUDIO_SAMPLE_INTERVAL_MS);
  }, [setListeningState]);

  const cleanupRecorderState = useCallback(() => {
    isSpeechActiveRef.current = false;
    clearTimeout(maxRecordingTimerRef.current);
    maxRecordingTimerRef.current = null;
  }, []);

  const publishTtsToRoom = useCallback(async (audioBase64) => {
    if (!audioBase64) return;
    try {
      stopVADListening();
      setSpeakingState(true);

      const cleanBase64 = audioBase64.replace(/^data:audio\/\w+;base64,/, '');
      const bytes = Uint8Array.from(atob(cleanBase64), (char) => char.charCodeAt(0));
      const blob = new Blob([bytes], { type: 'audio/mpeg' });
      const url = URL.createObjectURL(blob);

      const audio = new Audio(url);
      audio.playbackRate = 1.12;
      ttsAudioRef.current = audio;

      const finalize = () => {
        setSpeakingState(false);
        URL.revokeObjectURL(url);
        ttsAudioRef.current = null;
        if (!isMutedRef.current && !isProcessingRef.current) {
          setTimeout(() => startVADListening(), POST_TTS_LOCKOUT_MS);
        }
      };
      audio.onended = finalize;
      audio.onerror = finalize;
      await audio.play();
    } catch (err) {
      console.error('[S2V] TTS play error:', err);
      setSpeakingState(false);
      if (!isMutedRef.current && !isProcessingRef.current) startVADListening();
    }
  }, [setSpeakingState, startVADListening, stopVADListening]);

  const processUtterance = useCallback(async (audioBlob) => {
    if (isProcessingRef.current || !audioBlob) return;
    isProcessingRef.current = true;
    setProcessing(true);

    try {
      const formData = new FormData();
      formData.append('audio', audioBlob, 'utterance.webm');
      formData.append('callId', callId || '');
      formData.append('conversationId', conversationIdRef.current || '');
      formData.append('preferredLanguage', preferredLanguage || 'en');

      const res = await fetch(`${apiBase || API_BASE_URL}/api/beyondpresence/process-speech`, {
        method: 'POST', body: formData,
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || 'Speech processing failed');

      if (data.conversationId) conversationIdRef.current = data.conversationId;

      if (data.transcript) {
        callbacksRef.current.onUserTranscription?.(data.transcript, {
          source: 's2v', eventKey: `s2v_user_${Date.now()}`,
        });
      }
      if (data.responseText) {
        callbacksRef.current.onAgentTranscription?.(data.responseText, {
          source: 's2v', eventKey: `s2v_agent_${Date.now()}`,
        });
      }
      if (data.audioBase64) {
        await publishTtsToRoom(data.audioBase64);
      } else if (!isMutedRef.current) {
        startVADListening();
      }
    } catch (err) {
      console.error('[S2V] processUtterance error:', err);
      if (!isMutedRef.current) startVADListening();
    } finally {
      isProcessingRef.current = false;
      setProcessing(false);
    }
  }, [callId, preferredLanguage, publishTtsToRoom, startVADListening]);

  const initMicCapture = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, sampleRate: 16000 },
      });
      micStreamRef.current = stream;

      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      audioContextRef.current = ctx;
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      source.connect(analyser);
      analyserRef.current = analyser;

      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus' : 'audio/webm';
      const recorder = new MediaRecorder(stream, { mimeType });

      recorder.ondataavailable = (e) => { if (e.data.size > 0) audioChunksRef.current.push(e.data); };
      recorder.onstop = () => {
        const speechDuration = Date.now() - (speechStartTimeRef.current || 0);
        const blob = new Blob(audioChunksRef.current, { type: mimeType });
        audioChunksRef.current = [];
        cleanupRecorderState();

        if (isMutedRef.current || speechDuration < MIN_SPEECH_DURATION_MS || blob.size <= 500) {
          if (!isMutedRef.current && !isProcessingRef.current) startVADListening();
          return;
        }
        stopVADListening();
        processUtterance(blob);
      };
      mediaRecorderRef.current = recorder;
      if (!isMutedRef.current) startVADListening();
      console.log('[S2V] Mic capture initialized');
    } catch (err) {
      console.error('[S2V] Mic init failed:', err);
      setError('Microphone access denied');
    }
  }, [cleanupRecorderState, processUtterance, startVADListening, stopVADListening]);

  const cleanupMic = useCallback(() => {
    stopVADListening();
    cleanupRecorderState();
    if (mediaRecorderRef.current?.state !== 'inactive') {
      try { mediaRecorderRef.current.stop(); } catch { /* noop */ }
    }
    mediaRecorderRef.current = null;
    if (micStreamRef.current) { micStreamRef.current.getTracks().forEach(t => t.stop()); micStreamRef.current = null; }
    if (audioContextRef.current) { audioContextRef.current.close().catch(() => { }); audioContextRef.current = null; }
    analyserRef.current = null;
    audioChunksRef.current = [];
  }, [cleanupRecorderState, stopVADListening]);

  const maybePlayInitialGreeting = useCallback(async () => {
    if (initialGreetingPlayedRef.current) return;
    let greetingAudio = initialGreetingAudioBase64;

    if (!greetingAudio && apiBase && conversationIdRef.current) {
      try {
        const res = await fetch(`${apiBase}/api/beyondpresence/send-greeting`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ conversationId: conversationIdRef.current }),
        });
        const data = await res.json();
        if (res.ok && !data.error) greetingAudio = data.audioBase64 || null;
      } catch (err) {
        console.warn('[S2V] Greeting fetch failed:', err);
      }
    }
    if (!greetingAudio) return;
    initialGreetingPlayedRef.current = true;
    await publishTtsToRoom(greetingAudio);
  }, [apiBase, initialGreetingAudioBase64, publishTtsToRoom]);

  // ── LiveKit room setup (friend's base + your additions) ───────────────────
  useEffect(() => {
    if (!livekitUrl || !livekitToken) return undefined;

    let cancelled = false;
    const room = new Room({ adaptiveStream: true, dynacast: true });
    roomRef.current = room;

    room.on(RoomEvent.TrackSubscribed, (track) => {
      if (cancelled) return;

      // NOTE: Video rendering is now handled by <AvatarVideo /> via useTracks.
      // We keep audio attachment here as a fallback for non-LiveKit-component audio.
      if (track.kind === Track.Kind.Audio) {
        const audioEl = track.attach();
        audioEl.style.display = 'none';
        audioEl.autoplay = true;
        audioEl.playsInline = true;
        audioEl.volume = 1.0;
        audioEl.muted = false;
        document.body.appendChild(audioEl);
        audioElementsRef.current.push(audioEl);
        audioEl.play().catch((err) => {
          console.warn('[BeyondPresence] Audio autoplay blocked, retrying on user gesture:', err);
          const retry = () => { audioEl.play().catch(() => { }); document.removeEventListener('click', retry); };
          document.addEventListener('click', retry, { once: true });
        });
      }
    });

    room.on(RoomEvent.TrackUnsubscribed, (track) => {
      track.detach().forEach((el) => el.remove());
      audioElementsRef.current = audioElementsRef.current.filter((el) => el.isConnected);
    });

    room.on(RoomEvent.DataReceived, (payload) => {
      if (cancelled) return;
      try {
        const msg = JSON.parse(new TextDecoder().decode(payload));
        const eventType = msg?.event_type || msg?.type;
        console.log('[BeyondPresence] Event:', eventType, msg);

        if (eventType === 'user.transcription' || eventType === 'user_transcription') {
          if (msg.text) {
            callbacksRef.current.onUserTranscription?.(msg.text, {
              source: 'beyondpresence',
              eventKey: msg.id || `${eventType}_${msg.text}_${msg.timestamp || Date.now()}`,
            });
            setListening(false);
          }
        }

        if (
          eventType === 'agent.transcription' ||
          eventType === 'agent_transcription' ||
          eventType === 'avatar.transcription'
        ) {
          if (msg.text) {
            callbacksRef.current.onAgentTranscription?.(msg.text, {
              source: 'beyondpresence',
              eventKey: msg.id || `${eventType}_${msg.text}_${msg.timestamp || Date.now()}`,
            });
          }
        }

        if (eventType === 'avatar.speak_started' || eventType === 'agent.speak_started') {
          setSpeaking(true);
          setListening(false);
        }

        if (eventType === 'avatar.speak_ended' || eventType === 'agent.speak_ended') {
          setSpeaking(false);
          setListening(true);
        }
      } catch { /* ignore non-JSON */ }
    });

    room.on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
      if (cancelled) return;
      const localIdentity = room.localParticipant.identity;
      const agentSpeaking = speakers.some((s) => s.identity !== localIdentity);
      setSpeaking(agentSpeaking);
      if (!agentSpeaking) setListening(true);
    });

    room.on(RoomEvent.Disconnected, () => {
      if (cancelled) return;
      setConnected(false);
      setSpeaking(false);
      setListening(false);
      cleanupMic();
      callbacksRef.current.onRoomRef?.(null);
      callbacksRef.current.onDisconnected?.();
    });

    room
      .connect(livekitUrl, livekitToken, { autoSubscribe: true })
      .then(async () => {
        if (cancelled) return;
        setConnected(true);
        setError(null);
        callbacksRef.current.onRoomRef?.(room);
        callbacksRef.current.onConnected?.();
        console.log('[BeyondPresence] Connected to LiveKit room');

        try {
          await room.localParticipant.setMicrophoneEnabled(!isMuted, {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          });
          setListening(!isMuted);
          console.log('[BeyondPresence] Microphone ready');
        } catch (err) {
          console.error('[BeyondPresence] Mic failed:', err);
        }

        await initMicCapture();
        await maybePlayInitialGreeting();
      })
      .catch((err) => {
        if (cancelled) return;
        console.error('[BeyondPresence] Connection failed:', err);
        setError(err.message);
        callbacksRef.current.onRoomRef?.(null);
      });

    return () => {
      cancelled = true;
      cleanupMic();
      callbacksRef.current.onRoomRef?.(null);
      audioElementsRef.current.forEach((el) => el.remove());
      audioElementsRef.current = [];
      if (ttsAudioRef.current) { ttsAudioRef.current.pause(); ttsAudioRef.current = null; }
      if (publishedTrackRef.current) {
        room.localParticipant.unpublishTrack(publishedTrackRef.current).catch(() => { });
        publishedTrackRef.current = null;
      }
      if (videoRef.current) videoRef.current.innerHTML = '';
      room.disconnect();
      roomRef.current = null;
      initialGreetingPlayedRef.current = false;
    };
  }, [cleanupMic, initMicCapture, isMuted, livekitToken, livekitUrl, maybePlayInitialGreeting]);

  // friend's LiveKit mute toggle
  useEffect(() => {
    const room = roomRef.current;
    if (!room || !connected) return;
    room.localParticipant.setMicrophoneEnabled(!isMuted, {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    }).then(() => {
      if (!speaking) setListening(!isMuted);
    }).catch((err) => {
      console.error('[BeyondPresence] Mute toggle failed:', err);
    });
  }, [connected, isMuted, speaking]);

  // your VAD mute/unmute
  useEffect(() => {
    if (!connected) return;
    if (isMuted) {
      stopVADListening();
      if (mediaRecorderRef.current?.state === 'recording') {
        try { mediaRecorderRef.current.stop(); } catch { /* noop */ }
      }
      audioChunksRef.current = [];
      cleanupRecorderState();
      return;
    }
    if (!speaking && !processing) startVADListening();
  }, [cleanupRecorderState, connected, isMuted, processing, speaking, startVADListening, stopVADListening]);

  const borderColor = speaking
    ? 'rgba(16,185,129,0.16)'
    : listening
      ? 'rgba(59,130,246,0.16)'
      : processing
        ? 'rgba(168,85,247,0.16)'
        : 'rgba(255,255,255,0.03)';

  const glowStyle = speaking
    ? 'inset 0 0 0 2px rgba(16,185,129,0.12)'
    : listening
      ? 'inset 0 0 0 2px rgba(59,130,246,0.12)'
      : processing
        ? 'inset 0 0 0 2px rgba(168,85,247,0.12)'
        : 'none';

  return (
    <>
      {/* 🔊 Handles all remote audio tracks via LiveKit's pipeline */}
      <RoomAudioRenderer />

      <div style={{ width: '100%', height: '100%' }}>
        <div
          style={{
            position: 'relative',
            width: '100%',
            height: '100%',
            borderRadius: 0,
            overflow: 'hidden',
            boxShadow: glowStyle,
            border: `2px solid ${borderColor}`,
            transition: 'box-shadow 0.4s ease, border-color 0.4s ease',
            background: '#05070d',
          }}
        >
          {/* 🎥 Avatar video — rendered by LiveKit components pipeline */}
          <div
            ref={videoRef}
            style={{
              width: '100%',
              height: '100%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <AvatarVideo videoRef={videoRef} />
          </div>

          {!connected && !error && (
            <div style={loaderWrap}>
              <div style={loaderDot} />
              <p style={loaderText}>Connecting to Dr. Christiana...</p>
            </div>
          )}

          {error && (
            <div style={loaderWrap}>
              <p style={{ color: '#f87171', fontSize: 13, textAlign: 'center', padding: '0 20px' }}>
                Connection failed: {error}
              </p>
            </div>
          )}

          {processing && connected && (
            <div style={processingBadge}>
              <div style={processingDot} />
              <span>Processing...</span>
            </div>
          )}
        </div>
        <style>{`
          @keyframes taPulse{0%,100%{opacity:.6}50%{opacity:1}}
          @keyframes spin{to{transform:rotate(360deg)}}
          @keyframes processPulse{0%,100%{opacity:0.7}50%{opacity:1}}
        `}</style>
      </div>
    </>
  );
}

// ─── Public export — wraps everything in LiveKitRoom ─────────────────────────
export default function BeyondPresenceStream(props) {
  const { livekitUrl, livekitToken, isMuted = false } = props;

  return (
    <LiveKitRoom
      serverUrl={livekitUrl}
      token={livekitToken}
      connect={!!(livekitUrl && livekitToken)}
      audio={!isMuted}
      video={true}
      options={{ adaptiveStream: true, dynacast: true }}
      style={{ width: '100%', height: '100%' }}
    >
      <BeyondPresenceInner {...props} />
    </LiveKitRoom>
  );
}

// ─── Styles ──────────────────────────────────────────────────────────────────
const loaderWrap = {
  position: 'absolute', inset: 0,
  display: 'flex', flexDirection: 'column',
  alignItems: 'center', justifyContent: 'center',
  background: '#0a0a14', gap: 12,
};
const loaderDot = {
  width: 36, height: 36,
  border: '3px solid rgba(139,92,246,0.3)',
  borderTopColor: '#a78bfa', borderRadius: '50%',
  animation: 'spin .8s linear infinite',
};
const loaderText = { color: '#a78bfa', fontSize: 13, fontWeight: 500 };
const processingBadge = {
  position: 'absolute', bottom: 16, left: '50%', transform: 'translateX(-50%)',
  display: 'flex', alignItems: 'center', gap: 8, padding: '8px 18px',
  background: 'rgba(139,92,246,0.2)', backdropFilter: 'blur(12px)',
  borderRadius: 20, border: '1px solid rgba(139,92,246,0.25)',
  color: '#c4b5fd', fontSize: 12, fontWeight: 600,
  animation: 'processPulse 1.5s ease-in-out infinite',
};
const processingDot = { width: 8, height: 8, borderRadius: '50%', background: '#a78bfa' };