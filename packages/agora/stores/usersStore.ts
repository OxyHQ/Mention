import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';

export interface UserEntity {
  id: string;
  username?: string;
  name?: { full?: string; first?: string; last?: string } | string;
  handle?: string;
  avatar?: string;
  verified?: boolean;
  bio?: string;
  createdAt?: string;
  [key: string]: any;
}

type CachedUser = {
  data: UserEntity;
  fetchedAt: number;
  isFull: boolean;
};

interface UsersState {
  usersById: Record<string, CachedUser>;
  idByUsername: Record<string, string>;
  ttlMs: number;

  upsertUser: (user: Partial<UserEntity> & { id?: string }) => void;
  getCachedById: (id: string) => UserEntity | undefined;

  ensureById: (
    id: string,
    loader: (id: string) => Promise<UserEntity | null | undefined>,
    opts?: { force?: boolean }
  ) => Promise<UserEntity | undefined>;
}

const now = () => Date.now();

export const useUsersStore = create<UsersState>()(
  subscribeWithSelector((set, get) => ({
    usersById: {},
    idByUsername: {},
    ttlMs: 5 * 60 * 1000,

    upsertUser: (user) => {
      if (!user) return;
      const id = String(user.id ?? user._id ?? '');
      if (!id) return;
      const username = user.username ?? user.handle;
      set((state) => {
        const prev = state.usersById[id]?.data || {};
        const merged: UserEntity = { ...prev, ...user, id };
        const isFull = Boolean(user.bio || user.createdAt);
        const next: UsersState['usersById'] = {
          ...state.usersById,
          [id]: { data: merged, fetchedAt: now(), isFull: isFull || state.usersById[id]?.isFull || false },
        };
        const nextMap = { ...state.idByUsername };
        if (username) nextMap[String(username).toLowerCase()] = id;
        return { usersById: next, idByUsername: nextMap };
      });
    },

    getCachedById: (id) => get().usersById[id]?.data,

    ensureById: async (id, loader, opts) => {
      const { ttlMs } = get();
      const cached = get().usersById[id];
      const fresh = cached && (!opts?.force) && now() - cached.fetchedAt < ttlMs;
      if (cached?.data && fresh && cached.isFull) return cached.data;
      const loaded = await loader(id).catch(() => undefined);
      if (loaded) {
        set((state) => {
          const username = loaded.username ?? loaded.handle;
          const nextUsers = {
            ...state.usersById,
            [id]: { data: { ...(state.usersById[id]?.data || {}), ...loaded, id }, fetchedAt: now(), isFull: true },
          };
          const nextMap = { ...state.idByUsername };
          if (username) nextMap[String(username).toLowerCase()] = id;
          return { usersById: nextUsers, idByUsername: nextMap };
        });
      }
      return loaded || cached?.data;
    },
  }))
);

export const useUserById = (id?: string) =>
  useUsersStore((s) => (id ? s.usersById[id]?.data : undefined));
