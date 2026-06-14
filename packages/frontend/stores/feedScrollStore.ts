import { create } from 'zustand';
import { FeedPostSlice, HydratedPost } from '@mention/shared-types';

/**
 * Session-scoped memory-mode retention store + local new-post bridge.
 *
 * This store is intentionally NOT persisted to disk. It keeps state in memory
 * for the lifetime of the app session so a memory-mode feed that unmounts (e.g.
 * when navigating from the home feed to `/videos`, which replaces the route via
 * `<Slot />`) can restore its previously-loaded feed items when it remounts. A
 * full reload naturally clears everything.
 *
 * Scroll-offset restoration is NOT handled here — it lives in Bloom's shared
 * `@oxyhq/bloom/scroll` primitive, keyed by the active route.
 *
 * The memory cache is keyed by the feed-identity key from `buildFeedScrollKey`,
 * so each distinct feed restores independently.
 */

/**
 * Cached memory-mode feed slice. Mirrors the local React state held by
 * `useFeedState` in memory mode so a remount can seed synchronously instead of
 * refetching page 1 (which would lose pages > 1 and invalidate the offset).
 */
export interface FeedMemoryCacheEntry {
    items: HydratedPost[];
    slices?: FeedPostSlice[];
    hasMore: boolean;
    nextCursor?: string;
}

interface FeedScrollStore {
    /** Map of feed-identity key → retained memory-mode feed slice. */
    memoryCache: Record<string, FeedMemoryCacheEntry>;
    setMemoryCache: (key: string, entry: FeedMemoryCacheEntry) => void;
    getMemoryCache: (key: string) => FeedMemoryCacheEntry | undefined;
    clearMemoryCache: (key: string) => void;
}

const useFeedScrollStore = create<FeedScrollStore>((set, get) => ({
    memoryCache: {},

    setMemoryCache: (key, entry) => {
        set((state) => ({ memoryCache: { ...state.memoryCache, [key]: entry } }));
    },

    getMemoryCache: (key) => get().memoryCache[key],

    clearMemoryCache: (key) => {
        set((state) => {
            if (!(key in state.memoryCache)) return state;
            const next = { ...state.memoryCache };
            delete next[key];
            return { memoryCache: next };
        });
    },
}));

/**
 * Read the retained memory-mode feed slice for a feed identity, if any.
 */
export function getFeedMemoryCache(key: string): FeedMemoryCacheEntry | undefined {
    return useFeedScrollStore.getState().getMemoryCache(key);
}

/**
 * Retain the current memory-mode feed slice for a feed identity so a remount
 * can warm-start from it instead of refetching from scratch.
 */
export function setFeedMemoryCache(key: string, entry: FeedMemoryCacheEntry): void {
    useFeedScrollStore.getState().setMemoryCache(key, entry);
}

/**
 * Drop the retained memory-mode slice for a feed identity. Used when a real
 * refresh / reloadKey change supersedes the cached data.
 */
export function clearFeedMemoryCache(key: string): void {
    useFeedScrollStore.getState().clearMemoryCache(key);
}

// ── Local new-post broadcast (memory-mode feeds) ─────────────────────
//
// On the SQLite path, `postsStore` inserts a freshly created post at the top of
// the relevant feeds and the home feed re-renders reactively. The memory-mode
// path (web without COOP/COEP, where SQLite is unavailable) keeps feed items in
// `useFeedState`'s local React state, which never reads SQLite — so it would
// otherwise miss the new post until a manual refresh or TTL.
//
// This lightweight, session-scoped broadcast bridges that gap: `postsStore`
// publishes the new item, every mounted memory-mode home feed prepends it to its
// live items, and any retained slice is updated so an unmount→remount still shows
// it. It is intentionally NOT a Zustand slice — subscribers are imperative feed
// hooks, not rendered state.

/** A post item prepended to memory-mode feeds. Shape matches a feed item. */
export type LocalNewPostListener = (item: HydratedPost) => void;

const localNewPostListeners = new Set<LocalNewPostListener>();

/**
 * Subscribe to newly created posts so a memory-mode feed can prepend them to its
 * live items. Returns an unsubscribe function. No-op for the SQLite path, which
 * updates reactively via selectors.
 */
export function subscribeToNewLocalPosts(listener: LocalNewPostListener): () => void {
    localNewPostListeners.add(listener);
    return () => {
        localNewPostListeners.delete(listener);
    };
}

/**
 * Broadcast a freshly created post to all mounted memory-mode feeds. Called by
 * `postsStore` after a successful create, mirroring the SQLite "insert at top"
 * behavior for the in-memory path.
 */
export function publishNewLocalPost(item: HydratedPost): void {
    for (const listener of localNewPostListeners) {
        listener(item);
    }
}

export { useFeedScrollStore };
