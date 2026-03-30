import { useCallback, useEffect } from 'react';
import { useEntityFollowStore } from '@/stores/entityFollowStore';

export function useFollowEntity(entityType: string, entityId: string) {
  const key = `${entityType}:${entityId}`;
  const isFollowing = useEntityFollowStore((s) => s.following[key] ?? false);
  const isLoading = useEntityFollowStore((s) => s.loading[key] ?? false);

  useEffect(() => {
    if (entityType && entityId) {
      useEntityFollowStore.getState().fetchStatus(entityType, entityId);
    }
  }, [entityType, entityId]);

  const toggle = useCallback(() => {
    return useEntityFollowStore.getState().toggleFollow(entityType, entityId);
  }, [entityType, entityId]);

  return { isFollowing, isLoading, toggle };
}
