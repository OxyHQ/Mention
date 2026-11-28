import { useEffect, useState } from 'react';
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

export default usePresence;
