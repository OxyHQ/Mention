import { useCallback } from 'react';
import { api } from '@/utils/api';
import { logger } from '@/utils/logger';

/**
 * Hook to emit follow/unfollow events to the backend for real-time updates
 * Use this after a successful follow/unfollow action from the Oxy service
 */
export function useFollowSocket() {
  /**
   * Emit a follow event to broadcast to all connected clients
   */
  const emitFollow = useCallback(async (followingId: string, counts?: { followerCount?: number; followingCount?: number }) => {
    try {
      await api.post('/follows/emit-follow', {
        followingId,
        followerCount: counts?.followerCount,
        followingCount: counts?.followingCount,
      });
    } catch (error) {
      // Non-critical: real-time broadcast failure should not block the follow action
      logger.warn('[useFollowSocket] Failed to emit follow event', followingId, error);
    }
  }, []);

  /**
   * Emit an unfollow event to broadcast to all connected clients
   */
  const emitUnfollow = useCallback(async (followingId: string, counts?: { followerCount?: number; followingCount?: number }) => {
    try {
      await api.post('/follows/emit-unfollow', {
        followingId,
        followerCount: counts?.followerCount,
        followingCount: counts?.followingCount,
      });
    } catch (error) {
      // Non-critical: real-time broadcast failure should not block the unfollow action
      logger.warn('[useFollowSocket] Failed to emit unfollow event', followingId, error);
    }
  }, []);

  return {
    emitFollow,
    emitUnfollow,
  };
}

export default useFollowSocket;
