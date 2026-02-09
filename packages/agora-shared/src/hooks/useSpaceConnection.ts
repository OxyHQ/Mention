import { useState, useEffect, useCallback, useRef } from 'react';
import { useAuth } from '@oxyhq/services';
import { createAudioPlayer } from 'expo-audio';
import { useAgoraConfig } from '../context/SpacesConfigContext';
import type { SpaceParticipant, StreamInfo } from '../types';

interface UseSpaceConnectionOptions {
  spaceId: string;
  enabled?: boolean;
}

interface UseSpaceConnectionReturn {
  isConnected: boolean;
  participants: SpaceParticipant[];
  myRole: 'host' | 'speaker' | 'listener' | null;
  isMuted: boolean;
  speakerRequests: Array<{ userId: string; requestedAt: string }>;
  activeStream: StreamInfo | null;
  join: () => void;
  leave: () => void;
  toggleMute: () => void;
  requestToSpeak: () => void;
  approveSpeaker: (userId: string) => void;
  denySpeaker: (userId: string) => void;
  removeSpeaker: (userId: string) => void;
  isSpaceEnded: boolean;
}

export function useSpaceConnection({
  spaceId,
  enabled = true,
}: UseSpaceConnectionOptions): UseSpaceConnectionReturn {
  const { user, isAuthenticated } = useAuth();
  const { spaceSocketService, introSound } = useAgoraConfig();
  const userId = user?.id;

  const [isConnected, setIsConnected] = useState(false);
  const [participants, setParticipants] = useState<SpaceParticipant[]>([]);
  const [isMuted, setIsMuted] = useState(true);
  const [speakerRequests, setSpeakerRequests] = useState<Array<{ userId: string; requestedAt: string }>>([]);
  const [isSpaceEnded, setIsSpaceEnded] = useState(false);
  const [activeStream, setActiveStream] = useState<StreamInfo | null>(null);
  const hasJoined = useRef(false);

  const myParticipant = participants.find((p) => p.userId === userId);
  const myRole = myParticipant?.role ?? null;

  useEffect(() => {
    if (!enabled || !isAuthenticated || !userId) return;
    spaceSocketService.connect(userId);
    const interval = setInterval(() => { setIsConnected(spaceSocketService.isConnected); }, 500);
    return () => { clearInterval(interval); };
  }, [enabled, isAuthenticated, userId, spaceSocketService]);

  useEffect(() => {
    if (!enabled) return;
    const unsubs: Array<() => void> = [];

    unsubs.push(spaceSocketService.onParticipantsUpdate((data) => {
      if (data.spaceId === spaceId) setParticipants(data.participants);
    }));
    unsubs.push(spaceSocketService.onParticipantMute((data) => {
      setParticipants((prev) => prev.map((p) => p.userId === data.userId ? { ...p, isMuted: data.isMuted } : p));
      if (data.userId === userId) setIsMuted(data.isMuted);
    }));
    unsubs.push(spaceSocketService.onSpeakerRequestReceived((data) => {
      if (data.spaceId === spaceId) {
        setSpeakerRequests((prev) => {
          if (prev.some((r) => r.userId === data.userId)) return prev;
          return [...prev, { userId: data.userId, requestedAt: data.timestamp }];
        });
      }
    }));
    unsubs.push(spaceSocketService.onSpaceEnded((data) => {
      if (data.spaceId === spaceId) { setIsSpaceEnded(true); setActiveStream(null); }
    }));
    unsubs.push(spaceSocketService.onSpeakerRemoved((data) => {
      if (data.spaceId === spaceId) setIsMuted(true);
    }));
    unsubs.push(spaceSocketService.onStreamStarted((data) => {
      if (data.spaceId === spaceId) setActiveStream({ title: data.title, image: data.image, description: data.description });
    }));
    unsubs.push(spaceSocketService.onStreamStopped((data) => {
      if (data.spaceId === spaceId) setActiveStream(null);
    }));

    return () => { unsubs.forEach((fn) => fn()); };
  }, [enabled, spaceId, userId, spaceSocketService]);

  const join = useCallback(() => {
    if (hasJoined.current) return;
    spaceSocketService.joinSpace(spaceId, (res) => {
      if (res.success && res.participants) {
        setParticipants(res.participants);
        hasJoined.current = true;
        if (introSound) {
          try { const player = createAudioPlayer(introSound); player.play(); } catch {}
        }
      }
    });
  }, [spaceId, spaceSocketService, introSound]);

  const leave = useCallback(() => {
    spaceSocketService.leaveSpace(spaceId);
    setParticipants([]);
    hasJoined.current = false;
  }, [spaceId, spaceSocketService]);

  const toggleMute = useCallback(() => {
    const newMuted = !isMuted;
    setIsMuted(newMuted);
    spaceSocketService.setMute(spaceId, newMuted);
  }, [spaceId, isMuted, spaceSocketService]);

  const requestToSpeak = useCallback(() => {
    if (myRole === 'speaker' || myRole === 'host') return;
    spaceSocketService.requestToSpeak(spaceId);
  }, [spaceId, myRole, spaceSocketService]);

  const approveSpeaker = useCallback((targetUserId: string) => {
    spaceSocketService.approveSpeaker(spaceId, targetUserId);
    setSpeakerRequests((prev) => prev.filter((r) => r.userId !== targetUserId));
  }, [spaceId, spaceSocketService]);

  const denySpeaker = useCallback((targetUserId: string) => {
    spaceSocketService.denySpeaker(spaceId, targetUserId);
    setSpeakerRequests((prev) => prev.filter((r) => r.userId !== targetUserId));
  }, [spaceId, spaceSocketService]);

  const removeSpeaker = useCallback((targetUserId: string) => {
    spaceSocketService.removeSpeaker(spaceId, targetUserId);
  }, [spaceId, spaceSocketService]);

  useEffect(() => {
    return () => {
      if (hasJoined.current && spaceId) {
        spaceSocketService.leaveSpace(spaceId);
        hasJoined.current = false;
      }
    };
  }, [spaceId, spaceSocketService]);

  return { isConnected, participants, myRole, isMuted, speakerRequests, activeStream, join, leave, toggleMute, requestToSpeak, approveSpeaker, denySpeaker, removeSpeaker, isSpaceEnded };
}
