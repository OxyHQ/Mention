import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";
import {
  upsertActor as dbUpsertActor,
  upsertManyActors as dbUpsertManyActors,
  primeActorsFromPosts as dbPrimeActorsFromPosts,
  getActorById as dbGetActorById,
  getActorByUsername as dbGetActorByUsername,
  isActorStale as dbIsActorStale,
  isActorFull as dbIsActorFull,
  invalidateActor as dbInvalidateActor,
  clearAllActors as dbClearAllActors,
} from '@/db';

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

interface UsersState {
  // Version counter — bumped on every data mutation to trigger re-reads from SQLite
  dataVersion: number;
  ttlMs: number;

  // Upserts
  upsertUser: (user: Partial<UserEntity> & { id?: string }) => void;
  upsertMany: (users: (Partial<UserEntity> & { id?: string })[]) => void;

  // Ingest from posts
  primeFromPosts: (posts: { user?: any }[]) => void;

  // Cache reads (synchronous from SQLite)
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

export const useUsersStore = create<UsersState>()(
  subscribeWithSelector((set, get) => ({
    dataVersion: 0,
    ttlMs: 5 * 60 * 1000, // 5 minutes

    upsertUser: (user) => {
      if (!user) return;
      const id = String(user.id ?? (user as any)._id ?? "");
      if (!id) return;

      const isFull = Boolean(
        (user as any)?.bio ||
        (user as any)?.privacySettings ||
        (user as any)?.links ||
        (user as any)?.linksMetadata ||
        (user as any)?.createdAt
      );

      dbUpsertActor({ ...user, id } as any, isFull);
      set((s) => ({ dataVersion: s.dataVersion + 1 }));
    },

    upsertMany: (users) => {
      if (!Array.isArray(users) || users.length === 0) return;
      const cleaned = users
        .filter(Boolean)
        .map((u) => {
          const id = String((u as any).id ?? (u as any)._id ?? "");
          return id ? { ...u, id } : null;
        })
        .filter(Boolean) as any[];

      if (cleaned.length === 0) return;

      dbUpsertManyActors(cleaned, false);
      set((s) => ({ dataVersion: s.dataVersion + 1 }));
    },

    primeFromPosts: (posts) => {
      if (!Array.isArray(posts) || posts.length === 0) return;
      dbPrimeActorsFromPosts(posts);
      // Don't bump version for primes — they happen during feed fetches
      // which already bump the postsStore version
    },

    getCachedById: (id) => {
      if (!id) return undefined;
      return dbGetActorById(id) ?? undefined;
    },

    getCachedByUsername: (username) => {
      if (!username) return undefined;
      return dbGetActorByUsername(username) ?? undefined;
    },

    ensureById: async (id, loader, opts) => {
      const { ttlMs } = get();

      // Check SQLite cache
      if (!opts?.force) {
        const stale = dbIsActorStale(id, ttlMs);
        if (!stale && dbIsActorFull(id)) {
          return dbGetActorById(id) ?? undefined;
        }
      }

      // Load from network
      const loaded = await loader(id).catch(() => undefined);
      if (loaded) {
        dbUpsertActor({ ...loaded, id } as any, true);
        set((s) => ({ dataVersion: s.dataVersion + 1 }));
      }

      return loaded || dbGetActorById(id) || undefined;
    },

    ensureByUsername: async (username, loader, opts) => {
      // Try to find by username in SQLite first
      const existing = dbGetActorByUsername(username);
      if (existing?.id) {
        return get().ensureById(existing.id, async () => loader(username), opts);
      }

      // Load from network
      const loaded = await loader(username).catch(() => undefined);
      if (loaded) {
        const id = String((loaded as any).id ?? (loaded as any)._id ?? "");
        if (id) {
          dbUpsertActor({ ...loaded, id } as any, true);
          set((s) => ({ dataVersion: s.dataVersion + 1 }));
        } else {
          get().upsertUser(loaded);
        }
      }

      return loaded || undefined;
    },

    invalidate: (idOrUsername) => {
      if (!idOrUsername) return;
      // Try as ID first
      const byId = dbGetActorById(idOrUsername);
      if (byId) {
        dbInvalidateActor(idOrUsername);
      } else {
        // Try as username
        const byUsername = dbGetActorByUsername(idOrUsername);
        if (byUsername?.id) {
          dbInvalidateActor(byUsername.id);
        }
      }
      set((s) => ({ dataVersion: s.dataVersion + 1 }));
    },

    clearAll: () => {
      dbClearAllActors();
      set((s) => ({ dataVersion: s.dataVersion + 1 }));
    },
  }))
);

// Selectors — read from SQLite, re-evaluate when dataVersion changes
export const useUserById = (id?: string) =>
  useUsersStore((s) => {
    // Subscribe to dataVersion for reactivity
    const _v = s.dataVersion;
    return id ? dbGetActorById(id) ?? undefined : undefined;
  });

export const useUserByUsername = (username?: string) =>
  useUsersStore((s) => {
    const _v = s.dataVersion;
    return username ? dbGetActorByUsername(username) ?? undefined : undefined;
  });
