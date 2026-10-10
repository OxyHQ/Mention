import { create } from 'zustand';
import type {
  FeedInterstitialSlot,
  FeedPostSlice,
  HydratedPost,
} from '@mention/shared-types';
import { getItemKey } from '@/utils/feedUtils';

/**
 * Session-scoped memory-mode retention store + local new-post bridge.
 *
 * This store is intentionally NOT persisted to disk. It keeps state in memory
 * for the lifetime of the app session so a memory-mode feed that unmounts (e.g.
 * when navigating from the home feed to `/videos`, which replaces the route via
 * `<Slot />`) can restore its previously-loaded feed items when it remounts. A
 * full reload naturally clears everything.
 *
 * Web offsets live in Bloom's route-aware scroll primitive. Native normally
 * keeps stack screens mounted, but route/tab swaps can still remount a feed, so
 * this module also keeps a tiny imperative offset map keyed by feed identity.
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
    /**
     * Recommendation-card placements accumulated across the loaded pages. Retained
     * with the items so a warm-started feed shows the same cards in the same places
     * it had before the unmount.
     */
    interstitials?: FeedInterstitialSlot[];
    hasMore: boolean;
    nextCursor?: string;
    /**
     * When this slice was retained, in `Date.now()` terms. A warm start compares
     * it against the last engagement write (`stores/engagementInvalidation`) to
     * tell a slice that still reflects the server from one that predates a like,
     * boost or save the viewer has since made.
     */
    retainedAt: number;
}

interface FeedScrollStore {
    /** Map of feed-identity key → retained memory-mode feed slice. */
    memoryCache: Record<string, FeedMemoryCacheEntry>;
    setMemoryCache: (key: string, entry: FeedMemoryCacheEntry) => void;
    getMemoryCache: (key: string) => FeedMemoryCacheEntry | undefined;
    clearMemoryCache: (key: string) => void;
    clearAllMemoryCaches: () => void;
}

const nativeFeedScrollOffsets = new Map<string, number>();

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

    clearAllMemoryCaches: () => {
        set({ memoryCache: {} });
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

/** Drop all session-retained feed state when the active viewer changes. */
export function clearAllFeedMemoryCaches(): void {
    useFeedScrollStore.getState().clearAllMemoryCaches();
    nativeFeedScrollOffsets.clear();
    ownNewPostScopes.clear();
}

/**
 * Put a post at the top of a retained slice: its items, and its slices when the
 * feed renders by slice. Returns the entry unchanged when the post is already
 * there.
 */
export function prependToMemoryCache(entry: FeedMemoryCacheEntry, item: HydratedPost): FeedMemoryCacheEntry {
    const key = getItemKey(item);
    if (entry.items.some((p) => getItemKey(p) === key)) return entry;
    const slices = entry.slices
        && !entry.slices.some((slice) => slice.items.some((si) => getItemKey(si.post) === key))
        ? [localPostSlice(item), ...entry.slices]
        : entry.slices;
    // The viewer's own new post does not make the slice any fresher than the
    // read it came from, so `retainedAt` stays; the card placements are
    // anchored by slice key and survive intact.
    return { ...entry, items: [item, ...entry.items], slices };
}

/** A single-post slice for a post the viewer just created. */
export function localPostSlice(item: HydratedPost): FeedPostSlice {
    return {
        _sliceKey: `local-new:${getItemKey(item)}`,
        isIncompleteThread: false,
        items: [{ post: item, isThreadParent: false, isThreadChild: false, isThreadLastChild: false }],
    };
}

/** Read the last native offset observed for a viewer/feed identity. */
export function getFeedScrollOffset(key: string): number {
    return nativeFeedScrollOffsets.get(key) ?? 0;
}

/** Save a native offset without publishing a Zustand update on every scroll. */
export function setFeedScrollOffset(key: string, offset: number): void {
    nativeFeedScrollOffsets.set(key, Math.max(0, offset));
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
 * Which of the viewer's new posts a retained memory-mode feed takes at its top:
 * all of them (a home feed) or one author's (a profile feed).
 */
export type OwnNewPostScope = { kind: 'home' } | { kind: 'author'; authorId: string };

// By feed identity, for every feed that has retained a slice this session. It
// outlives the feed's mount on purpose: a new post has to reach the retained
// slice of a feed that is NOT mounted (on web the composer replaces the home
// feed), or that feed warm-starts without it.
const ownNewPostScopes = new Map<string, OwnNewPostScope>();

/** Declare which of the viewer's new posts the feed retained under `key` takes. */
export function setFeedOwnNewPostScope(key: string, scope: OwnNewPostScope): void {
    ownNewPostScopes.set(key, scope);
}

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
 * Put a freshly created post at the top of every memory-mode feed it belongs
 * in — the retained slice of each one, mounted or not, and the live items of
 * the mounted ones. Called by `postsStore` after a successful create, mirroring
 * the SQLite "insert at top" for the in-memory path.
 */
export function publishNewLocalPost(item: HydratedPost): void {
    const authorId = String(item.user?.id ?? '');
    for (const [key, scope] of ownNewPostScopes) {
        if (scope.kind === 'author' && scope.authorId !== authorId) continue;
        const entry = getFeedMemoryCache(key);
        if (entry) setFeedMemoryCache(key, prependToMemoryCache(entry, item));
    }
    for (const listener of localNewPostListeners) {
        listener(item);
    }
    localPostRevision += 1;
    for (const listener of localPostRevisionListeners) {
        listener();
    }
}

// How many posts the viewer has published this session, as a revision a feed
// can compare against to know it has a new post of theirs at its top to bring
// into view (`hooks/useRevealOwnNewPost`). Counted for BOTH storage paths —
// unlike the item listeners above, which only memory-mode feeds need.
let localPostRevision = 0;
const localPostRevisionListeners = new Set<() => void>();

export function getLocalPostRevision(): number {
    return localPostRevision;
}

export function subscribeToLocalPostRevision(listener: () => void): () => void {
    localPostRevisionListeners.add(listener);
    return () => {
        localPostRevisionListeners.delete(listener);
    };
}

// ── Local new-reply broadcast (thread replies feeds) ─────────────────
//
// The sibling of the new-post broadcast, for the one kind of feed that one
// skips: a thread's replies list is a SCOPED memory feed, so a new post never
// belongs in it — but the viewer's own new reply to that thread does. The
// listener in `useFeedState` matches the reply's `parentPostId` against the
// feed's own scope, so a reply lands only in the thread it answers.

/** Invoked with the hydrated reply the server returned for a successful reply. */
export type LocalNewReplyListener = (reply: HydratedPost) => void;

const localNewReplyListeners = new Set<LocalNewReplyListener>();

/** Subscribe a replies feed to the viewer's new replies. Returns an unsubscribe function. */
export function subscribeToNewLocalReplies(listener: LocalNewReplyListener): () => void {
    localNewReplyListeners.add(listener);
    return () => {
        localNewReplyListeners.delete(listener);
    };
}

/** Broadcast a reply the server has accepted. Called by `postsStore.createReply`. */
export function publishNewLocalReply(reply: HydratedPost): void {
    for (const listener of localNewReplyListeners) {
        listener(reply);
    }
}

// ── Local post-removal broadcast (memory-mode feeds) ─────────────────
//
// The symmetric counterpart of the new-post broadcast above. On the SQLite path,
// `postsStore.removePostEverywhere` deletes the post from SQLite and notifies
// the affected feed keys, so their selectors re-read and the post vanishes.
// Memory-mode feeds (web without COOP/COEP, where SQLite is unavailable) keep
// their items in `useFeedState`'s local React state, which never reads SQLite —
// so a deleted post would linger until a manual refresh.
//
// This broadcast bridges that gap: `removePostEverywhere` publishes the removed
// id, every mounted memory-mode feed drops it from its live items + retained
// slice, and the post disappears instantly — mirroring the SQLite behavior.

/** A listener invoked with the id of a post removed from memory-mode feeds. */
export type LocalRemovedPostListener = (postId: string) => void;

const localRemovedPostListeners = new Set<LocalRemovedPostListener>();

/**
 * Subscribe to post removals so a memory-mode feed can drop them from its live
 * items + retained slice. Returns an unsubscribe function. No-op for the SQLite
 * path, which removes reactively via selectors after `removePostEverywhere`.
 */
export function subscribeToRemovedLocalPosts(listener: LocalRemovedPostListener): () => void {
    localRemovedPostListeners.add(listener);
    return () => {
        localRemovedPostListeners.delete(listener);
    };
}

/**
 * Broadcast a post removal to all mounted memory-mode feeds. Called by
 * `postsStore.removePostEverywhere` after deleting a post, mirroring the SQLite
 * reactive removal for the in-memory path.
 */
export function publishRemovedLocalPost(postId: string): void {
    for (const listener of localRemovedPostListeners) {
        listener(postId);
    }
}

export { useFeedScrollStore };
