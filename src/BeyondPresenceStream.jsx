import { useEffect, useRef, useState, useCallback } from 'react';
import { Room, RoomEvent, Track } from 'livekit-client';

/**
 * BeyondPresenceStream
 *
 * Connects to a LiveKit room where the server-side agent (agent.js) is running.
 * The agent handles:
 *   - Beyond Presence avatar video
 *   - OpenAI STT / LLM / TTS pipeline
 *   - KYC question flow
 *
 * This component just:
 *   - Joins the room as the patient
 *   - Renders the avatar video track
 *   - Attaches remote audio
 *   - Publishes local mic audio
 *   - Forwards transcript data events to parent callbacks
 */
export default function BeyondPresenceStream({
  onRoomReady,
  onConnected,
  livekitUrl,
  livekitToken,
  onUserTranscription,
  onAgentTranscription,
  onDisconnected,
  onRoomRef,
  onSpeakingChange,
  onListeningChange,
  isMuted = false,
}) {
  const videoRef = useRef(null);
  const roomRef = useRef(null);
  const audioElementsRef = useRef([]);
  const callbacksRef = useRef({});
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState(null);
  const [speaking, setSpeaking] = useState(false);
  const [listening, setListening] = useState(false);
  const hasConnectedRef = useRef(false);



  const sendQuestionToAgent = (text) => {
  if (!roomRef.current) {
    console.warn("Room not ready");
    return;
  }

  const payload = JSON.stringify({
    type: "ask_question",
    text,
  });

    roomRef.current.localParticipant.publishData(
      new TextEncoder().encode(payload),
      {
        reliable: true,
        topic: "agent" // 🔥 VERY IMPORTANT
      }
    );
};

  // Keep callbacks ref fresh without re-running the main effect
  useEffect(() => {
    callbacksRef.current = { onUserTranscription, onAgentTranscription, onConnected, onDisconnected, onRoomRef, onSpeakingChange, onListeningChange };
  });

  useEffect(() => { callbacksRef.current.onSpeakingChange?.(speaking); }, [speaking]);
  useEffect(() => { callbacksRef.current.onListeningChange?.(listening); }, [listening]);

  // Main room lifecycle
useEffect(() => {
  if (!livekitUrl || !livekitToken) return;
  if (hasConnectedRef.current) return;

  hasConnectedRef.current = true;

    let cancelled = false;

   const room = new Room({
  adaptiveStream: true,
  dynacast: true,
  disconnectOnPageLeave: true,
  reconnectPolicy: {
    maxRetries: 2,           // was unlimited by default
    retryInterval: 3000,     // 3s between retries (default is ~0ms)
    retryIntervalStep: 2000, // adds 2s per subsequent retry
  },
});
    roomRef.current = room;
    if (onRoomReady) {
  onRoomReady({
    sendQuestionToAgent,
  });
}

    // ── Track subscribed ──────────────────────────────────────────────────────
    room.on(RoomEvent.TrackSubscribed, (track, _publication, participant) => {
      if (cancelled) return;

      if (track.kind === Track.Kind.Video) {
        // Render avatar video
        const el = track.attach();
        el.style.cssText = 'width:100%;height:100%;object-fit:cover;display:block;border-radius:0;';
        if (videoRef.current) {
          videoRef.current.innerHTML = '';
          videoRef.current.appendChild(el);
        }
      }

      if (track.kind === Track.Kind.Audio) {
        // Attach remote audio (avatar voice)
        const audioEl = track.attach();
        audioEl.style.display = 'none';
        audioEl.autoplay = true;
        audioEl.playsInline = true;
        audioEl.volume = 1.0;
        audioEl.muted = false;
        document.body.appendChild(audioEl);
        audioElementsRef.current.push(audioEl);

        audioEl.play().catch(err => {
          console.warn('[BeyondPresence] Audio autoplay blocked, will retry on user gesture:', err);
          const retry = () => { audioEl.play().catch(() => {}); document.removeEventListener('click', retry); };
          document.addEventListener('click', retry, { once: true });
        });
      }
    });

    room.on(RoomEvent.TrackUnsubscribed, (track) => {
      track.detach().forEach(el => el.remove());
      audioElementsRef.current = audioElementsRef.current.filter(el => el.isConnected);
    });

    // ── Data messages (transcripts / speaking events from agent) ─────────────
    room.on(RoomEvent.DataReceived, (payload) => {
      if (cancelled) return;
      try {
        const msg = JSON.parse(new TextDecoder().decode(payload));
        const eventType = msg?.event_type || msg?.type;

        if (eventType === 'user.transcription' || eventType === 'user_transcription') {
          if (msg.text) {
            setListening(false);
            callbacksRef.current.onUserTranscription?.(msg.text, {
              source: 'beyondpresence',
              eventKey: msg.id || `${eventType}_${msg.text}_${msg.timestamp || Date.now()}`,
            });
          }
        }

        if (eventType === 'agent.transcription' || eventType === 'agent_transcription' || eventType === 'avatar.transcription') {
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
      } catch {
        // ignore non-JSON payloads
      }
    });

    // ── Active speakers (visual indicator) ───────────────────────────────────
    room.on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
      if (cancelled) return;
      const localIdentity = room.localParticipant.identity;
      const agentSpeaking = speakers.some(s => s.identity !== localIdentity);
      setSpeaking(agentSpeaking);
      if (!agentSpeaking) setListening(true);
    });

    // ── Disconnected ─────────────────────────────────────────────────────────
    room.on(RoomEvent.Disconnected, () => {
      if (cancelled) return;
      setConnected(false);
      setSpeaking(false);
      setListening(false);
      callbacksRef.current.onRoomRef?.(null);
      callbacksRef.current.onDisconnected?.();
    });

    // ── Connect ───────────────────────────────────────────────────────────────
    console.log("🔥 CONNECTING ONCE ONLY");
    room.connect(livekitUrl, livekitToken, { autoSubscribe: true })
      .then(async () => {
        if (cancelled) return;
        setConnected(true);
        setError(null);
        callbacksRef.current.onRoomRef?.(room);
        callbacksRef.current.onConnected?.();
        console.log('[BeyondPresence] Connected to LiveKit room:', room.name);

        try {
          await room.localParticipant.setMicrophoneEnabled(!isMuted, {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          });
          setListening(!isMuted);
          console.log('[BeyondPresence] Microphone ready, muted:', isMuted);
        } catch (err) {
          console.error('[BeyondPresence] Mic setup failed:', err);
        }
      })
      .catch(err => {
        if (cancelled) return;
        console.error('[BeyondPresence] Connection failed:', err);
        setError(err.message);
        callbacksRef.current.onRoomRef?.(null);
      });

    return () => {
      cancelled = true;
      hasConnectedRef.current = false;
      callbacksRef.current.onRoomRef?.(null);

      // Clean up audio elements
      audioElementsRef.current.forEach(el => {
        try { el.pause(); el.srcObject = null; el.remove(); } catch { }
      });
      audioElementsRef.current = [];

      // Clear video
      if (videoRef.current) {
        try { videoRef.current.innerHTML = ''; } catch { }
      }

      room.disconnect();
      roomRef.current = null;
    };
  }, [livekitUrl, livekitToken]); // isMuted intentionally excluded — handled separately below

  // ── Mute toggle (after connected) ────────────────────────────────────────
  useEffect(() => {
    const room = roomRef.current;
    if (!room || !connected) return;

    room.localParticipant.setMicrophoneEnabled(!isMuted, {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    }).then(() => {
      if (!speaking) setListening(!isMuted);
    }).catch(err => {
      console.error('[BeyondPresence] Mute toggle failed:', err);
    });
  }, [connected, isMuted, speaking]);

  // ── Styles ────────────────────────────────────────────────────────────────
  const borderColor = speaking
    ? 'rgba(16,185,129,0.4)'
    : listening
      ? 'rgba(59,130,246,0.3)'
      : 'rgba(255,255,255,0.06)';

  const glowShadow = speaking
    ? 'inset 0 0 0 2px rgba(16,185,129,0.2)'
    : listening
      ? 'inset 0 0 0 2px rgba(59,130,246,0.15)'
      : 'none';

  return (
    <div style={{ width: '100%', height: '100%' }}>
      <div
        style={{
          position: 'relative',
          width: '100%',
          height: '100%',
          borderRadius: 0,
          overflow: 'hidden',
          boxShadow: glowShadow,
          border: `2px solid ${borderColor}`,
          transition: 'box-shadow 0.4s ease, border-color 0.4s ease',
          background: '#05070d',
        }}
      >
        {/* Avatar video container */}
        <div
          ref={videoRef}
          style={{
            width: '100%',
            height: '100%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        />

        {/* Connecting indicator */}
        {!connected && !error && (
          <div style={loaderWrap}>
            <div style={loaderSpinner} />
            <p style={loaderText}>Connecting to Dr. Christiana...</p>
          </div>
        )}

        {/* Error indicator */}
        {error && (
          <div style={loaderWrap}>
            <p style={{ color: '#f87171', fontSize: 13, textAlign: 'center', padding: '0 20px' }}>
              Connection failed: {error}
            </p>
          </div>
        )}

        {/* Speaking / listening status pill */}
        {connected && (speaking || listening) && (
          <div style={{
            position: 'absolute',
            bottom: 16,
            left: '50%',
            transform: 'translateX(-50%)',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '6px 16px',
            background: speaking ? 'rgba(16,185,129,0.2)' : 'rgba(59,130,246,0.2)',
            backdropFilter: 'blur(12px)',
            borderRadius: 20,
            border: `1px solid ${speaking ? 'rgba(16,185,129,0.3)' : 'rgba(59,130,246,0.3)'}`,
            color: speaking ? '#34d399' : '#93c5fd',
            fontSize: 12,
            fontWeight: 600,
            pointerEvents: 'none',
          }}>
            <div style={{
              width: 8,
              height: 8,
              borderRadius: '50%',
              background: speaking ? '#34d399' : '#60a5fa',
              animation: 'beyondPresencePulse 1.2s ease-in-out infinite',
            }} />
            {speaking ? 'Dr. Christiana is speaking' : 'Listening...'}
          </div>
        )}
      </div>

      <style>{`
        @keyframes beyondPresenceSpin { to { transform: rotate(360deg); } }
        @keyframes beyondPresencePulse { 0%,100%{opacity:0.6} 50%{opacity:1} }
      `}</style>
    </div>
  );
}

const loaderWrap = {
  position: 'absolute',
  inset: 0,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  background: '#0a0a14',
  gap: 12,
};

const loaderSpinner = {
  width: 36,
  height: 36,
  border: '3px solid rgba(139,92,246,0.3)',
  borderTopColor: '#a78bfa',
  borderRadius: '50%',
  animation: 'beyondPresenceSpin 0.8s linear infinite',
};

const loaderText = {
  color: '#a78bfa',
  fontSize: 13,
  fontWeight: 500,
};