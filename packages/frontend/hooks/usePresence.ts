import { useEffect, useState, useMemo } from 'react';
import { socketService } from '@/services/socketService';

/**
 * Hook to track a user's online/offline status in real-time
 */
export function usePresence(userId: string | undefined): boolean {
  const [isOnline, setIsOnline] = useState(false);

  useEffect(() => {
    if (!userId) {
      setIsOnline(false);
      return;
    }

    let cancelled = false;

    // Subscribe to presence updates
    const unsubscribe = socketService.subscribeToPresence(userId, (online) => {
      if (!cancelled) setIsOnline(online);
    });

    // Get initial presence (guarded against setState after unmount)
    socketService
      .getPresence(userId)
      .then((online) => {
        if (!cancelled) setIsOnline(online);
      })
      .catch(() => {
        if (!cancelled) setIsOnline(false);
      });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [userId]);

  return isOnline;
}

/**
 * Hook to track multiple users' online/offline status
 */
export function usePresenceBulk(userIds: string[]): Record<string, boolean> {
  const [presenceMap, setPresenceMap] = useState<Record<string, boolean>>({});

  // Stable, order-independent key so the effect only re-runs when the set of
  // userIds actually changes — not on every render with a new array reference.
  const key = useMemo(() => [...userIds].sort().join(','), [userIds]);

  useEffect(() => {
    const ids = key ? key.split(',') : [];
    if (!ids.length) {
      setPresenceMap({});
      return;
    }

    let cancelled = false;

    // Get initial presence for all users (guarded against setState after unmount)
    socketService
      .getPresenceBulk(ids)
      .then((map) => {
        if (!cancelled) setPresenceMap(map);
      })
      .catch(() => {
        if (!cancelled) setPresenceMap({});
      });

    // Subscribe to each user's presence
    const unsubscribes = ids.map((userId) =>
      socketService.subscribeToPresence(userId, (online) => {
        if (!cancelled) {
          setPresenceMap((prev) => ({ ...prev, [userId]: online }));
        }
      })
    );

    return () => {
      cancelled = true;
      unsubscribes.forEach((unsubscribe) => unsubscribe());
    };
  }, [key]);

  return presenceMap;
}

/**
 * Hook to subscribe to follow count updates for a user
 */
export function useFollowUpdates(
  userId: string | undefined,
  onUpdate?: (data: { followerId: string; followingId: string; followerCount?: number; followingCount?: number }) => void
) {
  useEffect(() => {
    if (!userId || !onUpdate) return;

    const unsubscribe = socketService.subscribeToFollowUpdates(userId, onUpdate);
    return unsubscribe;
  }, [userId, onUpdate]);
}

export default usePresence;
