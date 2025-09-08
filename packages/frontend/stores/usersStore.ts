import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";

export interface UserEntity {
  id: string;
  username?: string;
  name?: { full?: string; first?: string; last?: string } | string;
  handle?: string; // alias for username if needed
  avatar?: string;
  verified?: boolean;
  bio?: string;
  createdAt?: string;
  // Allow any additional fields coming from services
  [key: string]: any;
}

type CachedUser = {
  data: UserEntity;
  fetchedAt: number;
  isFull: boolean; // true when loaded from profile endpoints, false when primed from posts
};

interface UsersState {
  usersById: Record<string, CachedUser>;
  idByUsername: Record<string, string>; // username -> id
  ttlMs: number; // cache time-to-live

  // Upserts
  upsertUser: (user: Partial<UserEntity> & { id?: string }) => void;
  upsertMany: (users: (Partial<UserEntity> & { id?: string })[]) => void;

  // Ingest from posts: extract embedded user objects
  primeFromPosts: (posts: { user?: any }[]) => void;

  // Cache reads (no network)
  getCachedById: (id: string) => UserEntity | undefined;
  getCachedByUsername: (username: string) => UserEntity | undefined;

  // Ensure helpers (cache-first with caller-provided loader)
  ensureById: (
    id: string,
    loader: (id: string) => Promise<UserEntity | null | undefined>,
    opts?: { force?: boolean }
  ) => Promise<UserEntity | undefined>;
  ensureByUsername: (
    username: string,
    loader: (username: string) => Promise<UserEntity | null | undefined>,
    opts?: { force?: boolean }
  ) => Promise<UserEntity | undefined>;

  // Invalidation
  invalidate: (idOrUsername: string) => void;
  clearAll: () => void;
}

const now = () => Date.now();

export const useUsersStore = create<UsersState>()(
  subscribeWithSelector((set, get) => ({
    usersById: {},
    idByUsername: {},
    ttlMs: 5 * 60 * 1000, // 5 minutes default

    upsertUser: (user) => {
      if (!user) return;
      const id = String(user.id ?? user._id ?? "");
      if (!id) return;
      const username = (user as any).username ?? (user as any).handle;
      set((state) => {
        const prev = state.usersById[id]?.data || {};
        const merged: UserEntity = { ...prev, ...user, id } as UserEntity;
        const isFull = Boolean(
          (user as any)?.bio || (user as any)?.privacySettings || (user as any)?.links || (user as any)?.linksMetadata || (user as any)?.createdAt
        );
        const next: UsersState["usersById"] = {
          ...state.usersById,
          [id]: { data: merged, fetchedAt: now(), isFull: isFull || state.usersById[id]?.isFull || false },
        };
        const nextMap = { ...state.idByUsername };
        if (username) nextMap[String(username).toLowerCase()] = id;
        return { usersById: next, idByUsername: nextMap } as Partial<UsersState> as any;
      });
    },

  upsertMany: (users) => {
      if (!Array.isArray(users) || users.length === 0) return;
      set((state) => {
        const nextUsers: UsersState["usersById"] = { ...state.usersById };
        const nextMap = { ...state.idByUsername };
        const ts = now();
        for (const u of users) {
          if (!u) continue;
          const id = String((u as any).id ?? (u as any)._id ?? "");
          if (!id) continue;
          const username = (u as any).username ?? (u as any).handle;
          const prev = nextUsers[id]?.data || {};
      // Bulk upserts are typically from posts, assume not full
      nextUsers[id] = { data: { ...prev, ...u, id } as UserEntity, fetchedAt: ts, isFull: nextUsers[id]?.isFull || false };
          if (username) nextMap[String(username).toLowerCase()] = id;
        }
        return { usersById: nextUsers, idByUsername: nextMap } as Partial<UsersState> as any;
      });
    },

    primeFromPosts: (posts) => {
      if (!Array.isArray(posts) || posts.length === 0) return;
      const users: any[] = [];
      for (const p of posts) {
        if (p?.user && (p.user.id || p.user._id)) users.push(p.user);
        // Also check embedded repost/quote headers if any
        if ((p as any)?.original?.user) users.push((p as any).original.user);
        if ((p as any)?.quoted?.user) users.push((p as any).quoted.user);
        if ((p as any)?.repostedBy) users.push((p as any).repostedBy);
      }
      if (users.length) get().upsertMany(users);
    },

    getCachedById: (id) => get().usersById[id]?.data,
    getCachedByUsername: (username) => {
      const id = get().idByUsername[username?.toLowerCase?.() || username];
      return id ? get().usersById[id]?.data : undefined;
    },

    ensureById: async (id, loader, opts) => {
      const { ttlMs } = get();
      const cached = get().usersById[id];
      const fresh = cached && (!opts?.force) && now() - cached.fetchedAt < ttlMs;
      // If cached exists and is fresh but NOT full, upgrade via loader
      if (cached?.data && fresh && cached.isFull) return cached.data;
      const loaded = await loader(id).catch(() => undefined);
      if (loaded) {
        // Mark as full on profile loads
        set((state) => {
          const username = (loaded as any).username ?? (loaded as any).handle;
          const nextUsers = {
            ...state.usersById,
            [id]: { data: { ...(state.usersById[id]?.data || {}), ...loaded, id } as UserEntity, fetchedAt: now(), isFull: true },
          };
          const nextMap = { ...state.idByUsername };
          if (username) nextMap[String(username).toLowerCase()] = id;
          return { usersById: nextUsers, idByUsername: nextMap } as Partial<UsersState> as any;
        });
      }
      return loaded || cached?.data;
    },

    ensureByUsername: async (username, loader, opts) => {
      const key = username?.toLowerCase?.() || username;
      const id = get().idByUsername[key];
      if (id) return get().ensureById(id, async () => loader(username), opts);
      const loaded = await loader(username).catch(() => undefined);
      if (loaded) {
        // if we don't yet know id, derive it
        const id = String((loaded as any).id ?? (loaded as any)._id ?? "");
        if (id) {
          set((state) => {
            const nextUsers = {
              ...state.usersById,
              [id]: { data: { ...(state.usersById[id]?.data || {}), ...loaded, id } as UserEntity, fetchedAt: now(), isFull: true },
            };
            const nextMap = { ...state.idByUsername };
            const uname = (loaded as any).username ?? (loaded as any).handle;
            if (uname) nextMap[String(uname).toLowerCase()] = id;
            return { usersById: nextUsers, idByUsername: nextMap } as Partial<UsersState> as any;
          });
        } else {
          get().upsertUser(loaded);
        }
      }
      return loaded || undefined;
    },

    invalidate: (idOrUsername) => {
      set((state) => {
        const key = idOrUsername?.toLowerCase?.() || idOrUsername;
        // If username mapped, translate to id
        const id = state.usersById[idOrUsername]?.data
          ? idOrUsername
          : state.idByUsername[key];
        if (!id) return {} as any;
        const next = { ...state.usersById };
        delete next[id];
        // Also clear username mapping pointing to this id
        const nextMap = { ...state.idByUsername };
        for (const uname in nextMap) {
          if (nextMap[uname] === id) delete nextMap[uname];
        }
        return { usersById: next, idByUsername: nextMap } as Partial<UsersState> as any;
      });
    },

    clearAll: () => set({ usersById: {}, idByUsername: {} })
  }))
);

// Hooks/selectors
export const useUserById = (id?: string) =>
  useUsersStore((s) => (id ? s.usersById[id]?.data : undefined));

export const useUserByUsername = (username?: string) =>
  useUsersStore((s) => (username ? s.getCachedByUsername(username) : undefined));
