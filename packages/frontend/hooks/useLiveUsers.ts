import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getLiveUsers } from '@/lib/liveConfig';

export interface LiveUsersState {
  /** Whether the given Oxy user id is currently live in a Syra room. */
  isLive: (userId: string | undefined) => boolean;
  /** The live room id to join for a live user, or `undefined` when not live. */
  roomIdFor: (userId: string | undefined) => string | undefined;
}

/**
 * Shared, app-wide poll of who is currently live in a Syra room. ONE React Query
 * (`['live-users']`) backs every avatar — the badge simply reads the resulting
 * `Map<userId, roomId>`, so mounting hundreds of avatars costs a single request,
 * refreshed on a background interval. Fails soft: any error leaves the map empty
 * (no avatar shows a live badge), so live presence never breaks a feed or profile.
 */
export function useLiveUsers(): LiveUsersState {
  const { data } = useQuery({
    queryKey: ['live-users'],
    queryFn: getLiveUsers,
    staleTime: 30_000,
    refetchInterval: 60_000,
    retry: false,
  });

  return useMemo<LiveUsersState>(() => {
    const byId = new Map<string, string>();
    for (const entry of data ?? []) {
      if (entry.userId && entry.roomId) byId.set(entry.userId, entry.roomId);
    }
    return {
      isLive: (userId) => (userId ? byId.has(userId) : false),
      roomIdFor: (userId) => (userId ? byId.get(userId) : undefined),
    };
  }, [data]);
}
