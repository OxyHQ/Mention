import { useState, useEffect, useRef } from 'react';
import { Platform } from 'react-native';
import { Room, RoomEvent, Track, ConnectionState } from 'livekit-client';
import { setAudioModeAsync } from 'expo-audio';
import { useSpacesConfig } from '../context/SpacesConfigContext';

let AudioSession: any = null;
if (Platform.OS !== 'web') {
  try { AudioSession = require('@livekit/react-native').AudioSession; } catch {}
}

interface UseSpaceAudioOptions {
  spaceId: string;
  isSpeaker: boolean;
  isMuted: boolean;
  isConnected: boolean;
}

interface UseSpaceAudioReturn {
  isLiveKitConnected: boolean;
  localAudioEnabled: boolean;
  micPermissionDenied: boolean;
}

export function useSpaceAudio({ spaceId, isSpeaker, isMuted, isConnected }: UseSpaceAudioOptions): UseSpaceAudioReturn {
  const { getSpaceToken } = useSpacesConfig();
  const [isLiveKitConnected, setIsLiveKitConnected] = useState(false);
  const [localAudioEnabled, setLocalAudioEnabled] = useState(false);
  const [micPermissionDenied, setMicPermissionDenied] = useState(false);
  const roomRef = useRef<Room | null>(null);
  const audioElementsRef = useRef<Map<string, any>>(new Map());

  useEffect(() => {
    if (!isConnected || Platform.OS === 'web') return;
    (async () => {
      try {
        await setAudioModeAsync({ shouldPlayInBackground: true, playsInSilentMode: true, interruptionMode: 'duckOthers' });
      } catch {}
      if (AudioSession) AudioSession.startAudioSession();
    })();
    return () => { if (AudioSession) AudioSession.stopAudioSession(); };
  }, [isConnected]);

  useEffect(() => {
    if (!isConnected || !spaceId) return;
    let cancelled = false;
    const room = new Room({ adaptiveStream: true, dynacast: true });
    roomRef.current = room;

    room.on(RoomEvent.Connected, () => { if (!cancelled) { setIsLiveKitConnected(true); } });
    room.on(RoomEvent.Disconnected, () => { if (!cancelled) { setIsLiveKitConnected(false); setLocalAudioEnabled(false); } });
    room.on(RoomEvent.TrackSubscribed, (track, _pub, _participant) => {
      if (track.kind === Track.Kind.Audio && Platform.OS === 'web' && typeof track.attach === 'function') {
        const el = track.attach();
        audioElementsRef.current.set(track.sid ?? '', el);
      }
    });
    room.on(RoomEvent.TrackUnsubscribed, (track) => {
      if (track.kind === Track.Kind.Audio && Platform.OS === 'web' && typeof track.detach === 'function') {
        track.detach();
        audioElementsRef.current.delete(track.sid ?? '');
      }
    });

    (async () => {
      try {
        const { token, url } = await getSpaceToken(spaceId);
        if (cancelled || !url) return;
        await room.connect(url, token);
      } catch (err) { console.warn('[SpaceAudio] LiveKit connection error:', err); }
    })();

    return () => {
      cancelled = true;
      if (Platform.OS === 'web') {
        audioElementsRef.current.forEach((el) => { el.pause(); el.srcObject = null; el.remove(); });
        audioElementsRef.current.clear();
      }
      room.disconnect();
      roomRef.current = null;
      setIsLiveKitConnected(false);
      setLocalAudioEnabled(false);
    };
  }, [isConnected, spaceId, getSpaceToken]);

  useEffect(() => {
    const room = roomRef.current;
    if (!room || room.state !== ConnectionState.Connected) return;
    const shouldPublish = isSpeaker && !isMuted;
    room.localParticipant.setMicrophoneEnabled(shouldPublish)
      .then(() => { setLocalAudioEnabled(shouldPublish); setMicPermissionDenied(false); })
      .catch((err) => {
        console.warn('[SpaceAudio] Failed to toggle mic:', err);
        if (err instanceof Error && err.name === 'NotAllowedError') setMicPermissionDenied(true);
      });
  }, [isSpeaker, isMuted, isLiveKitConnected]);

  return { isLiveKitConnected, localAudioEnabled, micPermissionDenied };
}
