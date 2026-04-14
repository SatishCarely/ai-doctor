import { useEffect, useRef, useState } from 'react';
import { Room, RoomEvent, Track } from 'livekit-client';

const extractEventText = (payload) => {
  if (!payload) return '';

  const candidates = [
    payload.text,
    payload.transcript,
    payload.message,
    payload.content,
    payload.data?.text,
    payload.data?.transcript,
    payload.data?.message,
    payload.data?.content,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
  }

  return '';
};

export default function BeyondPresenceStream({
  livekitUrl,
  livekitToken,
  onUserTranscription,
  onAgentTranscription,
  onConnected,
  onDisconnected,
  onRoomRef,
}) {
  const videoRef = useRef(null);
  const roomRef = useRef(null);
  const audioElementsRef = useRef([]);
  const callbacksRef = useRef({
    onUserTranscription,
    onAgentTranscription,
    onConnected,
    onDisconnected,
    onRoomRef,
  });
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState(null);
  const [speaking, setSpeaking] = useState(false);
  const [listening, setListening] = useState(false);

  useEffect(() => {
    callbacksRef.current = {
      onUserTranscription,
      onAgentTranscription,
      onConnected,
      onDisconnected,
      onRoomRef,
    };
  });

  useEffect(() => {
    if (!livekitUrl || !livekitToken) return;

    let cancelled = false;
    const room = new Room({ adaptiveStream: true, dynacast: true });
    roomRef.current = room;

    room.on(RoomEvent.TrackSubscribed, (track) => {
      if (cancelled) return;

      if (track.kind === Track.Kind.Video) {
        const el = track.attach();
        el.style.width = '100%';
        el.style.height = '100%';
        el.style.objectFit = 'cover';
        el.style.borderRadius = '0';
        if (videoRef.current) {
          videoRef.current.innerHTML = '';
          videoRef.current.appendChild(el);
        }
      }

      if (track.kind === Track.Kind.Audio) {
        const audioEl = track.attach();
        audioEl.style.display = 'none';
        audioEl.autoplay = true;
        audioEl.playsInline = true;
        document.body.appendChild(audioEl);
        audioElementsRef.current.push(audioEl);
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
        const text = extractEventText(msg);
        const eventKey = msg?.id || msg?.event_id || msg?.message_id || msg?.created_at || null;
        console.log('[BeyondPresence] Event:', eventType, msg);

        if (
          eventType === 'user.transcription' ||
          eventType === 'user_transcription' ||
          eventType === 'transcription.user'
        ) {
          if (text) {
            callbacksRef.current.onUserTranscription?.(text, { eventKey, source: 'livekit', raw: msg });
            setListening(false);
          }
        }
        if (
          eventType === 'agent.transcription' ||
          eventType === 'agent_transcription' ||
          eventType === 'avatar.transcription' ||
          eventType === 'transcription.agent' ||
          eventType === 'transcription.avatar'
        ) {
          if (text) {
            callbacksRef.current.onAgentTranscription?.(text, { eventKey, source: 'livekit', raw: msg });
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
        // Non-JSON data
      }
    });

    room.on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
      if (cancelled) return;
      const agentSpeaking = speakers.some(
        (speaker) => speaker.identity !== room.localParticipant.identity
      );
      setSpeaking(agentSpeaking);
      if (!agentSpeaking) setListening(true);
    });

    room.on(RoomEvent.Disconnected, () => {
      if (cancelled) return;
      setConnected(false);
      callbacksRef.current.onRoomRef?.(null);
      callbacksRef.current.onDisconnected?.();
    });

    room
      .connect(livekitUrl, livekitToken)
      .then(async () => {
        if (cancelled) return;
        setConnected(true);
        setError(null);
        callbacksRef.current.onRoomRef?.(room);
        callbacksRef.current.onConnected?.();
        console.log('[BeyondPresence] Connected to LiveKit room');

        try {
          await room.localParticipant.setMicrophoneEnabled(true, {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          });
          console.log('[BeyondPresence] Microphone ready');
        } catch (err) {
          console.error('[BeyondPresence] Mic failed:', err);
        }
      })
      .catch((err) => {
        if (cancelled) return;
        console.error('[BeyondPresence] Connection failed:', err);
        setError(err.message);
        callbacksRef.current.onRoomRef?.(null);
      });

    return () => {
      cancelled = true;
      callbacksRef.current.onRoomRef?.(null);
      audioElementsRef.current.forEach((el) => el.remove());
      audioElementsRef.current = [];
      if (videoRef.current) videoRef.current.innerHTML = '';
      room.disconnect();
      roomRef.current = null;
    };
  }, [livekitToken, livekitUrl]);

  const borderColor = speaking
    ? 'rgba(16,185,129,0.16)'
    : listening
      ? 'rgba(59,130,246,0.16)'
      : 'rgba(255,255,255,0.03)';

  const glowStyle = speaking
    ? 'inset 0 0 0 2px rgba(16,185,129,0.12)'
    : listening
      ? 'inset 0 0 0 2px rgba(59,130,246,0.12)'
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
          boxShadow: glowStyle,
          border: `2px solid ${borderColor}`,
          transition: 'box-shadow 0.4s ease, border-color 0.4s ease',
          background: '#05070d',
        }}
      >
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

      </div>
      <style>{`@keyframes taPulse{0%,100%{opacity:.6}50%{opacity:1}} @keyframes spin{to{transform:rotate(360deg)}}`}</style>
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

const loaderDot = {
  width: 36,
  height: 36,
  border: '3px solid rgba(139,92,246,0.3)',
  borderTopColor: '#a78bfa',
  borderRadius: '50%',
  animation: 'spin .8s linear infinite',
};

const loaderText = {
  color: '#a78bfa',
  fontSize: 13,
  fontWeight: 500,
};
