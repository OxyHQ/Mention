import { useState, useEffect, useCallback, useRef } from 'react';
import { useAuth } from '@oxyhq/services';
import {
  spaceSocketService,
  SpaceParticipant,
} from '@/services/spaceSocketService';

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
  activeStreamUrl: string | null;
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
  const userId = user?.id;

  const [isConnected, setIsConnected] = useState(false);
  const [participants, setParticipants] = useState<SpaceParticipant[]>([]);
  const [isMuted, setIsMuted] = useState(true);
  const [speakerRequests, setSpeakerRequests] = useState<
    Array<{ userId: string; requestedAt: string }>
  >([]);
  const [isSpaceEnded, setIsSpaceEnded] = useState(false);
  const [activeStreamUrl, setActiveStreamUrl] = useState<string | null>(null);

  const hasJoined = useRef(false);

  // Derived state
  const myParticipant = participants.find((p) => p.userId === userId);
  const myRole = myParticipant?.role ?? null;

  // Connect to /spaces namespace
  useEffect(() => {
    if (!enabled || !isAuthenticated || !userId) return;

    spaceSocketService.connect(userId);

    const interval = setInterval(() => {
      const connected = spaceSocketService.isConnected;
      setIsConnected(connected);
    }, 500);

    return () => {
      clearInterval(interval);
    };
  }, [enabled, isAuthenticated, userId]);

  // Setup event listeners
  useEffect(() => {
    if (!enabled) return;

    const unsubs: Array<() => void> = [];

    unsubs.push(
      spaceSocketService.onParticipantsUpdate((data) => {
        if (data.spaceId === spaceId) {
          setParticipants(data.participants);
        }
      })
    );

    unsubs.push(
      spaceSocketService.onParticipantMute((data) => {
        setParticipants((prev) =>
          prev.map((p) =>
            p.userId === data.userId ? { ...p, isMuted: data.isMuted } : p
          )
        );
        // Update our own mute state
        if (data.userId === userId) {
          setIsMuted(data.isMuted);
        }
      })
    );

    unsubs.push(
      spaceSocketService.onSpeakerRequestReceived((data) => {
        if (data.spaceId === spaceId) {
          setSpeakerRequests((prev) => {
            if (prev.some((r) => r.userId === data.userId)) return prev;
            return [...prev, { userId: data.userId, requestedAt: data.timestamp }];
          });
        }
      })
    );

    unsubs.push(
      spaceSocketService.onSpaceEnded((data) => {
        if (data.spaceId === spaceId) {
          setIsSpaceEnded(true);
          setActiveStreamUrl(null);
        }
      })
    );

    unsubs.push(
      spaceSocketService.onSpeakerRemoved((data) => {
        if (data.spaceId === spaceId) {
          // Role update will come via participants:update
          setIsMuted(true);
        }
      })
    );

    unsubs.push(
      spaceSocketService.onStreamStarted((data) => {
        if (data.spaceId === spaceId) {
          setActiveStreamUrl(data.url);
        }
      })
    );

    unsubs.push(
      spaceSocketService.onStreamStopped((data) => {
        if (data.spaceId === spaceId) {
          setActiveStreamUrl(null);
        }
      })
    );

    return () => {
      unsubs.forEach((fn) => fn());
    };
  }, [enabled, spaceId, userId]);

  // Join
  const join = useCallback(() => {
    if (hasJoined.current) return;
    spaceSocketService.joinSpace(spaceId, (res) => {
      if (res.success && res.participants) {
        setParticipants(res.participants);
        hasJoined.current = true;
      }
    });
  }, [spaceId]);

  // Leave
  const leave = useCallback(() => {
    spaceSocketService.leaveSpace(spaceId);
    setParticipants([]);
    hasJoined.current = false;
  }, [spaceId]);

  // Toggle mute
  const toggleMute = useCallback(() => {
    const newMuted = !isMuted;
    setIsMuted(newMuted);
    spaceSocketService.setMute(spaceId, newMuted);
  }, [spaceId, isMuted]);

  // Request to speak (skip if already a speaker/host — backend also deduplicates)
  const requestToSpeak = useCallback(() => {
    if (myRole === 'speaker' || myRole === 'host') return;
    spaceSocketService.requestToSpeak(spaceId);
  }, [spaceId, myRole]);

  // Approve speaker
  const approveSpeaker = useCallback(
    (targetUserId: string) => {
      spaceSocketService.approveSpeaker(spaceId, targetUserId);
      setSpeakerRequests((prev) =>
        prev.filter((r) => r.userId !== targetUserId)
      );
    },
    [spaceId]
  );

  // Deny speaker
  const denySpeaker = useCallback(
    (targetUserId: string) => {
      spaceSocketService.denySpeaker(spaceId, targetUserId);
      setSpeakerRequests((prev) =>
        prev.filter((r) => r.userId !== targetUserId)
      );
    },
    [spaceId]
  );

  // Remove speaker
  const removeSpeaker = useCallback(
    (targetUserId: string) => {
      spaceSocketService.removeSpeaker(spaceId, targetUserId);
    },
    [spaceId]
  );

  // Cleanup on unmount — leave the space but keep the socket alive
  // (the singleton socket is shared across hooks; disconnecting it here
  // would tear down listeners registered by other components)
  useEffect(() => {
    return () => {
      if (hasJoined.current && spaceId) {
        spaceSocketService.leaveSpace(spaceId);
        hasJoined.current = false;
      }
    };
  }, [spaceId]);

  return {
    isConnected,
    participants,
    myRole,
    isMuted,
    speakerRequests,
    activeStreamUrl,
    join,
    leave,
    toggleMute,
    requestToSpeak,
    approveSpeaker,
    denySpeaker,
    removeSpeaker,
    isSpaceEnded,
  };
}
