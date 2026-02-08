import { useState, useEffect, useRef } from 'react';
import { Platform } from 'react-native';
import { Room, RoomEvent, Track, ConnectionState } from 'livekit-client';
import { setAudioModeAsync } from 'expo-audio';
import { getSpaceToken } from '@/services/livekitService';

// Conditionally import native-only modules
let AudioSession: any = null;
if (Platform.OS !== 'web') {
  try {
    AudioSession = require('@livekit/react-native').AudioSession;
  } catch {}
}

interface UseSpaceAudioOptions {
  spaceId: string;
  isSpeaker: boolean;
  isMuted: boolean;
  isConnected: boolean; // Socket.IO connected (gate for joining LiveKit)
}

interface UseSpaceAudioReturn {
  isLiveKitConnected: boolean;
  localAudioEnabled: boolean;
  micPermissionDenied: boolean;
}

export function useSpaceAudio({
  spaceId,
  isSpeaker,
  isMuted,
  isConnected,
}: UseSpaceAudioOptions): UseSpaceAudioReturn {
  const [isLiveKitConnected, setIsLiveKitConnected] = useState(false);
  const [localAudioEnabled, setLocalAudioEnabled] = useState(false);
  const [micPermissionDenied, setMicPermissionDenied] = useState(false);
  const roomRef = useRef<Room | null>(null);
  // Track attached <audio> elements on web for cleanup (no-op on native)
  const audioElementsRef = useRef<Map<string, HTMLMediaElement>>(new Map());

  // Audio session lifecycle (native only)
  useEffect(() => {
    if (!isConnected || Platform.OS === 'web') return;

    (async () => {
      try {
        await setAudioModeAsync({
          shouldPlayInBackground: true,
          playsInSilentMode: true,
          interruptionMode: 'duckOthers',
        });
      } catch {}
      if (AudioSession) {
        AudioSession.startAudioSession();
      }
    })();

    return () => {
      if (AudioSession) {
        AudioSession.stopAudioSession();
      }
    };
  }, [isConnected]);

  // Connect to LiveKit room when socket is connected
  useEffect(() => {
    if (!isConnected || !spaceId) return;

    let cancelled = false;
    const room = new Room({
      adaptiveStream: true,
      dynacast: true,
    });
    roomRef.current = room;

    room.on(RoomEvent.Connected, () => {
      if (!cancelled) {
        console.log('[SpaceAudio] LiveKit connected');
        setIsLiveKitConnected(true);
      }
    });

    room.on(RoomEvent.Disconnected, () => {
      if (!cancelled) {
        console.log('[SpaceAudio] LiveKit disconnected');
        setIsLiveKitConnected(false);
        setLocalAudioEnabled(false);
      }
    });

    room.on(RoomEvent.TrackSubscribed, (track, _pub, participant) => {
      if (track.kind === Track.Kind.Audio) {
        console.log(`[SpaceAudio] Subscribed to audio from ${participant.identity}`);
        // On web, livekit-client does NOT auto-play remote audio — we must
        // attach the track to an <audio> DOM element. On native,
        // registerGlobals() handles auto-play through the native audio layer.
        if (Platform.OS === 'web' && typeof track.attach === 'function') {
          const el = track.attach();
          audioElementsRef.current.set(track.sid, el);
        }
      }
    });

    room.on(RoomEvent.TrackUnsubscribed, (track, _pub, participant) => {
      if (track.kind === Track.Kind.Audio) {
        console.log(`[SpaceAudio] Unsubscribed from audio of ${participant.identity}`);
        if (Platform.OS === 'web' && typeof track.detach === 'function') {
          track.detach();
          audioElementsRef.current.delete(track.sid);
        }
      }
    });

    (async () => {
      try {
        const { token, url } = await getSpaceToken(spaceId);
        if (cancelled) return;
        if (!url) {
          console.error('[SpaceAudio] No LiveKit URL returned — check LIVEKIT_URL env var on backend');
          return;
        }
        console.log('[SpaceAudio] Connecting to LiveKit...', url);
        await room.connect(url, token);
      } catch (err) {
        console.warn('[SpaceAudio] LiveKit connection error:', err);
      }
    })();

    return () => {
      cancelled = true;
      console.log('[SpaceAudio] Disconnecting from LiveKit');
      // Clean up attached <audio> elements on web before disconnecting
      if (Platform.OS === 'web') {
        audioElementsRef.current.forEach((el) => {
          el.pause();
          el.srcObject = null;
          el.remove();
        });
        audioElementsRef.current.clear();
      }
      room.disconnect();
      roomRef.current = null;
      setIsLiveKitConnected(false);
      setLocalAudioEnabled(false);
    };
  }, [isConnected, spaceId]);

  // Mic publish/unpublish based on role + mute state
  useEffect(() => {
    const room = roomRef.current;
    if (!room || room.state !== ConnectionState.Connected) return;

    const shouldPublish = isSpeaker && !isMuted;

    room.localParticipant
      .setMicrophoneEnabled(shouldPublish)
      .then(() => {
        setLocalAudioEnabled(shouldPublish);
        setMicPermissionDenied(false);
        console.log(`[SpaceAudio] Mic ${shouldPublish ? 'enabled' : 'disabled'}`);
      })
      .catch((err) => {
        console.warn('[SpaceAudio] Failed to toggle mic:', err);
        if (err instanceof Error && err.name === 'NotAllowedError') {
          setMicPermissionDenied(true);
        }
      });
  }, [isSpeaker, isMuted, isLiveKitConnected]);

  return {
    isLiveKitConnected,
    localAudioEnabled,
    micPermissionDenied,
  };
}
