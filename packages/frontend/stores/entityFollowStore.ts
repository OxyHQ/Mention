import { create } from 'zustand';
import { entityFollowService, type EntityFollowType } from '@/services/entityFollowService';
import { logger } from '@/lib/logger';

interface EntityFollowState {
  following: Record<string, boolean>;  // key: "type:id"
  loading: Record<string, boolean>;

  fetchStatus: (entityType: EntityFollowType, entityId: string) => Promise<void>;
  toggleFollow: (entityType: EntityFollowType, entityId: string) => Promise<void>;
  setStatus: (entityType: EntityFollowType, entityId: string, isFollowing: boolean) => void;
  reset: () => void;
}

const key = (type: EntityFollowType, id: string) => `${type}:${id}`;
let viewerEpoch = 0;

export const useEntityFollowStore = create<EntityFollowState>((set, get) => ({
  following: {},
  loading: {},

  fetchStatus: async (entityType, entityId) => {
    const k = key(entityType, entityId);
    if (get().loading[k] || k in get().following) return;
    const operationEpoch = viewerEpoch;
    set((s) => ({ loading: { ...s.loading, [k]: true } }));
    try {
      const isFollowing = await entityFollowService.getStatus(entityType, entityId);
      if (operationEpoch !== viewerEpoch) return;
      set((s) => ({ following: { ...s.following, [k]: isFollowing }, loading: { ...s.loading, [k]: false } }));
    } catch (error) {
      if (operationEpoch !== viewerEpoch) return;
      logger.warn('Failed to load entity follow status', { error, entityType, entityId });
      set((s) => ({ loading: { ...s.loading, [k]: false } }));
    }
  },

  toggleFollow: async (entityType, entityId) => {
    const k = key(entityType, entityId);
    const current = get().following[k] ?? false;
    const operationEpoch = viewerEpoch;
    set((s) => ({ following: { ...s.following, [k]: !current }, loading: { ...s.loading, [k]: true } }));
    try {
      if (current) {
        await entityFollowService.unfollow(entityType, entityId);
      } else {
        await entityFollowService.follow(entityType, entityId);
      }
      if (operationEpoch !== viewerEpoch) return;
      set((s) => ({ loading: { ...s.loading, [k]: false } }));
    } catch (error) {
      if (operationEpoch !== viewerEpoch) return;
      logger.warn('Failed to toggle entity follow', { error, entityType, entityId });
      set((s) => ({ following: { ...s.following, [k]: current }, loading: { ...s.loading, [k]: false } }));
    }
  },

  setStatus: (entityType, entityId, isFollowing) => {
    const k = key(entityType, entityId);
    set((s) => ({ following: { ...s.following, [k]: isFollowing } }));
  },

  reset: () => {
    viewerEpoch += 1;
    set({ following: {}, loading: {} });
  },
}));
