import { create } from 'zustand';
import { FeedPostSlice, HydratedPost } from '@mention/shared-types';

/**
 * Session-scoped feed scroll + memory-mode retention store.
 *
 * This store is intentionally NOT persisted to disk. It keeps state in memory
 * for the lifetime of the app session so a screen that unmounts (e.g. when
 * navigating from the home feed to `/videos`, which replaces the route via
 * `<Slot />`) can restore both:
 *   1. the exact scroll offset, and
 *   2. (memory-mode only) the previously-loaded feed items,
 * when it remounts. A full reload naturally clears everything.
 *
 * Both maps are keyed by the feed-identity key from `buildFeedScrollKey`, so
 * each distinct feed restores independently.
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
    /** Map of feed-identity key → last saved vertical scroll offset (px). */
    offsets: Record<string, number>;
    /** Map of feed-identity key → retained memory-mode feed slice. */
    memoryCache: Record<string, FeedMemoryCacheEntry>;
    setOffset: (key: string, offset: number) => void;
    getOffset: (key: string) => number | undefined;
    setMemoryCache: (key: string, entry: FeedMemoryCacheEntry) => void;
    getMemoryCache: (key: string) => FeedMemoryCacheEntry | undefined;
    clearMemoryCache: (key: string) => void;
}

const useFeedScrollStore = create<FeedScrollStore>((set, get) => ({
    offsets: {},
    memoryCache: {},

    setOffset: (key, offset) => {
        const current = get().offsets[key];
        if (current === offset) return;
        set((state) => ({ offsets: { ...state.offsets, [key]: offset } }));
    },

    getOffset: (key) => get().offsets[key],

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
 * Read the saved scroll offset for a feed identity. Returns `undefined` when no
 * offset has been recorded yet (fresh feed).
 */
export function getFeedScroll(key: string): number | undefined {
    return useFeedScrollStore.getState().getOffset(key);
}

/**
 * Persist the latest scroll offset for a feed identity (session-scoped).
 */
export function setFeedScroll(key: string, offset: number): void {
    useFeedScrollStore.getState().setOffset(key, offset);
}

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

export { useFeedScrollStore };
