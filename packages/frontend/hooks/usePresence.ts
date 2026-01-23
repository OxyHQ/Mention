import { useEffect, useState, useCallback } from 'react';
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

    // Subscribe to presence updates
    const unsubscribe = socketService.subscribeToPresence(userId, (online) => {
      setIsOnline(online);
    });

    // Get initial presence
    socketService.getPresence(userId).then(setIsOnline);

    return unsubscribe;
  }, [userId]);

  return isOnline;
}

/**
 * Hook to track multiple users' online/offline status
 */
export function usePresenceBulk(userIds: string[]): Record<string, boolean> {
  const [presenceMap, setPresenceMap] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (!userIds.length) {
      setPresenceMap({});
      return;
    }

    // Get initial presence for all users
    socketService.getPresenceBulk(userIds).then(setPresenceMap);

    // Subscribe to each user's presence
    const unsubscribes = userIds.map(userId =>
      socketService.subscribeToPresence(userId, (online) => {
        setPresenceMap(prev => ({ ...prev, [userId]: online }));
      })
    );

    return () => {
      unsubscribes.forEach(unsubscribe => unsubscribe());
    };
  }, [userIds.join(',')]);

  return presenceMap;
}

/**
 * Hook to subscribe to follow count updates for a user
 */
export function useFollowUpdates(
  userId: string | undefined,
  onUpdate?: (data: { followerId: string; followingId: string; followerCount: number; followingCount: number }) => void
) {
  useEffect(() => {
    if (!userId || !onUpdate) return;

    const unsubscribe = socketService.subscribeToFollowUpdates(userId, onUpdate);
    return unsubscribe;
  }, [userId, onUpdate]);
}

export default usePresence;
