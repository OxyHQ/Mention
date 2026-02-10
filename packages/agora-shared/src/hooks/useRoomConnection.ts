import { useState, useEffect, useCallback, useRef } from 'react';
import { useAuth } from '@oxyhq/services';
import { createAudioPlayer } from 'expo-audio';
import { useAgoraConfig } from '../context/AgoraConfigContext';
import type { RoomParticipant, StreamInfo } from '../types';

interface UseRoomConnectionOptions {
  roomId: string;
  enabled?: boolean;
}

interface UseRoomConnectionReturn {
  isConnected: boolean;
  participants: RoomParticipant[];
  myRole: 'host' | 'speaker' | 'listener' | null;
  isMuted: boolean;
  speakerRequests: Array<{ userId: string; requestedAt: string }>;
  activeStream: StreamInfo | null;
  isRecording: boolean;
  activeRecordingId: string | null;
  join: () => void;
  leave: () => void;
  toggleMute: () => void;
  requestToSpeak: () => void;
  approveSpeaker: (userId: string) => void;
  denySpeaker: (userId: string) => void;
  removeSpeaker: (userId: string) => void;
  isRoomEnded: boolean;
}

export function useRoomConnection({
  roomId,
  enabled = true,
}: UseRoomConnectionOptions): UseRoomConnectionReturn {
  const { user, isAuthenticated } = useAuth();
  const { roomSocketService, introSound } = useAgoraConfig();
  const userId = user?.id;

  const [isConnected, setIsConnected] = useState(false);
  const [participants, setParticipants] = useState<RoomParticipant[]>([]);
  const [isMuted, setIsMuted] = useState(true);
  const [speakerRequests, setSpeakerRequests] = useState<Array<{ userId: string; requestedAt: string }>>([]);
  const [isRoomEnded, setIsRoomEnded] = useState(false);
  const [activeStream, setActiveStream] = useState<StreamInfo | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [activeRecordingId, setActiveRecordingId] = useState<string | null>(null);
  const hasJoined = useRef(false);

  const myParticipant = participants.find((p) => p.userId === userId);
  const myRole = myParticipant?.role ?? null;

  useEffect(() => {
    if (!enabled || !isAuthenticated || !userId) return;
    roomSocketService.connect(userId);
    const interval = setInterval(() => { setIsConnected(roomSocketService.isConnected); }, 500);
    return () => { clearInterval(interval); };
  }, [enabled, isAuthenticated, userId, roomSocketService]);

  useEffect(() => {
    if (!enabled) return;
    const unsubs: Array<() => void> = [];

    unsubs.push(roomSocketService.onParticipantsUpdate((data) => {
      if (data.roomId === roomId) setParticipants(data.participants);
    }));
    unsubs.push(roomSocketService.onParticipantMute((data) => {
      setParticipants((prev) => prev.map((p) => p.userId === data.userId ? { ...p, isMuted: data.isMuted } : p));
      if (data.userId === userId) setIsMuted(data.isMuted);
    }));
    unsubs.push(roomSocketService.onSpeakerRequestReceived((data) => {
      if (data.roomId === roomId) {
        setSpeakerRequests((prev) => {
          if (prev.some((r) => r.userId === data.userId)) return prev;
          return [...prev, { userId: data.userId, requestedAt: data.timestamp }];
        });
      }
    }));
    unsubs.push(roomSocketService.onRoomEnded((data) => {
      if (data.roomId === roomId) { setIsRoomEnded(true); setActiveStream(null); }
    }));
    unsubs.push(roomSocketService.onSpeakerRemoved((data) => {
      if (data.roomId === roomId) setIsMuted(true);
    }));
    unsubs.push(roomSocketService.onStreamStarted((data) => {
      if (data.roomId === roomId) setActiveStream({ title: data.title, image: data.image, description: data.description });
    }));
    unsubs.push(roomSocketService.onStreamStopped((data) => {
      if (data.roomId === roomId) setActiveStream(null);
    }));
    unsubs.push(roomSocketService.onRecordingStarted((data) => {
      if (data.roomId === roomId) {
        setIsRecording(true);
        setActiveRecordingId(data.recordingId);
      }
    }));
    unsubs.push(roomSocketService.onRecordingStopped((data) => {
      if (data.roomId === roomId) {
        setIsRecording(false);
        setActiveRecordingId(null);
      }
    }));

    return () => { unsubs.forEach((fn) => fn()); };
  }, [enabled, roomId, userId, roomSocketService]);

  const join = useCallback(() => {
    if (hasJoined.current) return;
    roomSocketService.joinRoom(roomId, (res) => {
      if (res.success && res.participants) {
        setParticipants(res.participants);
        hasJoined.current = true;
        if (introSound) {
          try { const player = createAudioPlayer(introSound); player.play(); } catch {}
        }
      }
    });
  }, [roomId, roomSocketService, introSound]);

  const leave = useCallback(() => {
    roomSocketService.leaveRoom(roomId);
    setParticipants([]);
    hasJoined.current = false;
  }, [roomId, roomSocketService]);

  const toggleMute = useCallback(() => {
    const newMuted = !isMuted;
    setIsMuted(newMuted);
    roomSocketService.setMute(roomId, newMuted);
  }, [roomId, isMuted, roomSocketService]);

  const requestToSpeak = useCallback(() => {
    if (myRole === 'speaker' || myRole === 'host') return;
    roomSocketService.requestToSpeak(roomId);
  }, [roomId, myRole, roomSocketService]);

  const approveSpeaker = useCallback((targetUserId: string) => {
    roomSocketService.approveSpeaker(roomId, targetUserId);
    setSpeakerRequests((prev) => prev.filter((r) => r.userId !== targetUserId));
  }, [roomId, roomSocketService]);

  const denySpeaker = useCallback((targetUserId: string) => {
    roomSocketService.denySpeaker(roomId, targetUserId);
    setSpeakerRequests((prev) => prev.filter((r) => r.userId !== targetUserId));
  }, [roomId, roomSocketService]);

  const removeSpeaker = useCallback((targetUserId: string) => {
    roomSocketService.removeSpeaker(roomId, targetUserId);
  }, [roomId, roomSocketService]);

  useEffect(() => {
    return () => {
      if (hasJoined.current && roomId) {
        roomSocketService.leaveRoom(roomId);
        hasJoined.current = false;
      }
    };
  }, [roomId, roomSocketService]);

  return { isConnected, participants, myRole, isMuted, speakerRequests, activeStream, isRecording, activeRecordingId, join, leave, toggleMute, requestToSpeak, approveSpeaker, denySpeaker, removeSpeaker, isRoomEnded };
}
