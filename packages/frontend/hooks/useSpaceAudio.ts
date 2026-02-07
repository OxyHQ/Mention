import { useState, useEffect, useRef } from 'react';
import { Platform } from 'react-native';
import { Room, RoomEvent, Track, ConnectionState } from 'livekit-client';
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
}

export function useSpaceAudio({
  spaceId,
  isSpeaker,
  isMuted,
  isConnected,
}: UseSpaceAudioOptions): UseSpaceAudioReturn {
  const [isLiveKitConnected, setIsLiveKitConnected] = useState(false);
  const [localAudioEnabled, setLocalAudioEnabled] = useState(false);
  const roomRef = useRef<Room | null>(null);

  // Audio session lifecycle (native only)
  useEffect(() => {
    if (!isConnected || Platform.OS === 'web') return;
    if (!AudioSession) return;

    AudioSession.startAudioSession();
    return () => {
      AudioSession.stopAudioSession();
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
        // LiveKit auto-plays subscribed audio tracks on native
      }
    });

    room.on(RoomEvent.TrackUnsubscribed, (track, _pub, participant) => {
      if (track.kind === Track.Kind.Audio) {
        console.log(`[SpaceAudio] Unsubscribed from audio of ${participant.identity}`);
      }
    });

    (async () => {
      try {
        const { token, url } = await getSpaceToken(spaceId);
        if (cancelled) return;
        console.log('[SpaceAudio] Connecting to LiveKit...');
        await room.connect(url, token);
      } catch (err) {
        console.warn('[SpaceAudio] LiveKit connection error:', err);
      }
    })();

    return () => {
      cancelled = true;
      console.log('[SpaceAudio] Disconnecting from LiveKit');
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
        console.log(`[SpaceAudio] Mic ${shouldPublish ? 'enabled' : 'disabled'}`);
      })
      .catch((err) => {
        console.warn('[SpaceAudio] Failed to toggle mic:', err);
      });
  }, [isSpeaker, isMuted, isLiveKitConnected]);

  return {
    isLiveKitConnected,
    localAudioEnabled,
  };
}
