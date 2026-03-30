import { create } from 'zustand';
import { entityFollowService } from '@/services/entityFollowService';

interface EntityFollowState {
  following: Record<string, boolean>;  // key: "type:id"
  loading: Record<string, boolean>;

  fetchStatus: (entityType: string, entityId: string) => Promise<void>;
  toggleFollow: (entityType: string, entityId: string) => Promise<void>;
  setStatus: (entityType: string, entityId: string, isFollowing: boolean) => void;
}

const key = (type: string, id: string) => `${type}:${id}`;

export const useEntityFollowStore = create<EntityFollowState>((set, get) => ({
  following: {},
  loading: {},

  fetchStatus: async (entityType, entityId) => {
    const k = key(entityType, entityId);
    if (get().loading[k] || k in get().following) return;
    set((s) => ({ loading: { ...s.loading, [k]: true } }));
    try {
      const isFollowing = await entityFollowService.getStatus(entityType, entityId);
      set((s) => ({ following: { ...s.following, [k]: isFollowing }, loading: { ...s.loading, [k]: false } }));
    } catch {
      set((s) => ({ loading: { ...s.loading, [k]: false } }));
    }
  },

  toggleFollow: async (entityType, entityId) => {
    const k = key(entityType, entityId);
    const current = get().following[k] ?? false;
    set((s) => ({ following: { ...s.following, [k]: !current }, loading: { ...s.loading, [k]: true } }));
    try {
      if (current) {
        await entityFollowService.unfollow(entityType, entityId);
      } else {
        await entityFollowService.follow(entityType, entityId);
      }
      set((s) => ({ loading: { ...s.loading, [k]: false } }));
    } catch {
      set((s) => ({ following: { ...s.following, [k]: current }, loading: { ...s.loading, [k]: false } }));
    }
  },

  setStatus: (entityType, entityId, isFollowing) => {
    const k = key(entityType, entityId);
    set((s) => ({ following: { ...s.following, [k]: isFollowing } }));
  },
}));
