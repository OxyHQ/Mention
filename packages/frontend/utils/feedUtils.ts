/**
 * Feed utility functions
 * Shared utilities for feed normalization, deduplication, and type safety
 */

import type { DependencyList } from 'react';
import type {
    FeedInterstitialSlot,
    FeedPostSlice,
    FeedType,
    FeedFilters as SharedFeedFilters,
    HydratedPost,
} from '@mention/shared-types';

// Extended FeedFilters with additional properties used by the app.
// The index signature is what `serializeFeedFilters` and `shallowFiltersEqual`
// walk, so it states the real contract: filters are a flat bag of scalars.
export interface FeedFilters extends SharedFeedFilters {
    searchQuery?: string;
    postId?: string;
    parentPostId?: string;
    customFeedId?: string;
    hashtag?: string;
    topic?: string;
    /**
     * One lane's tab. The lane already knows its own publisher, so this is the
     * whole scope — a lane feed is NOT an author feed and must never be fetched
     * as one. Three files have to agree on that: this field, the explicit branch
     * in `feedService`, and the matching branch in `feedTelemetry`.
     */
    laneId?: string;
    /** Reply ordering, as the replies feed sends it to the API. */
    sort?: string;
    [key: string]: string | boolean | undefined;
}

/**
 * An id as it can reach the feed key helpers: a string, a numeric id, or a
 * Mongo `ObjectId`-like object that stringifies to its hex form.
 */
type FeedEntityId = string | number | { toString(): string };

/**
 * The id-bearing shape every feed entity is keyed by. Deliberately structural
 * and fully optional: posts, replies, boosts, slice items and cached rows all
 * flow through here carrying different subsets of these fields.
 */
interface KeyableFeedEntity {
    id?: FeedEntityId;
    _id?: FeedEntityId;
    _id_str?: FeedEntityId;
    postId?: FeedEntityId;
    post?: { id?: FeedEntityId; _id?: FeedEntityId };
    username?: string;
}

/** Renders one candidate id field, or `''` when it is absent/empty. */
function readEntityId(value: FeedEntityId | undefined): string {
    if (value === undefined || value === null || value === '') return '';
    return String(value);
}

/**
 * Normalize item ID for consistent deduplication
 * Handles various ID formats: id, _id, _id_str, postId, post.id, post._id
 */
export function normalizeItemId(item: unknown): string {
    if (item === null || typeof item !== 'object') return '';
    const entity = item as KeyableFeedEntity;

    const direct =
        readEntityId(entity.id) ||
        readEntityId(entity._id) ||
        readEntityId(entity._id_str) ||
        readEntityId(entity.postId);
    if (direct) return direct;

    const post = entity.post;
    if (post) return readEntityId(post.id) || readEntityId(post._id);
    return '';
}

/**
 * Extract item key using normalization
 */
export function getItemKey(item: unknown): string {
    const normalizedId = normalizeItemId(item);

    if (normalizedId && normalizedId !== 'undefined' && normalizedId !== 'null') {
        return normalizedId;
    }

    // Fallback to username or JSON stringification as last resort
    const username = item !== null && typeof item === 'object'
        ? (item as KeyableFeedEntity).username
        : undefined;
    return username || String(JSON.stringify(item));
}

export interface FeedPageContent {
    items?: readonly HydratedPost[];
    slices?: readonly FeedPostSlice[];
    interstitials?: readonly FeedInterstitialSlot[];
}

export interface MergedFeedPageContent {
    items: HydratedPost[];
    slices?: FeedPostSlice[];
    interstitials?: FeedInterstitialSlot[];
}

/**
 * Merge accumulated feed data with another page while preserving first-seen
 * order and removing every form of page-boundary overlap.
 *
 * The API exposes the same feed in two representations: flat `items` and
 * grouped `slices`. Both must be normalized because the renderer prefers
 * slices whenever they exist. Posts are deduplicated by their canonical item
 * id, empty slices are removed, duplicate slice/slot keys keep their first
 * occurrence, and slots whose anchor disappeared are discarded. Boost wrappers
 * intentionally remain distinct from their originals because feeds use that
 * relationship as ranking/social context.
 */
export function mergeFeedPageContent(
    accumulated: FeedPageContent | undefined,
    incoming: FeedPageContent,
): MergedFeedPageContent {
    const items: HydratedPost[] = [];
    const seenItemKeys = new Set<string>();

    for (const item of [...(accumulated?.items ?? []), ...(incoming.items ?? [])]) {
        const key = getItemKey(item);
        if (!key || seenItemKeys.has(key)) continue;
        seenItemKeys.add(key);
        items.push(item);
    }

    const slices: FeedPostSlice[] = [];
    const seenSliceKeys = new Set<string>();
    const seenSlicePostKeys = new Set<string>();

    for (const slice of [...(accumulated?.slices ?? []), ...(incoming.slices ?? [])]) {
        if (!slice?._sliceKey || seenSliceKeys.has(slice._sliceKey)) continue;

        const uniqueItems = slice.items.filter((sliceItem) => {
            const key = getItemKey(sliceItem?.post);
            if (!key || seenSlicePostKeys.has(key)) return false;
            seenSlicePostKeys.add(key);
            return true;
        });
        if (uniqueItems.length === 0) continue;

        seenSliceKeys.add(slice._sliceKey);
        slices.push(
            uniqueItems.length === slice.items.length
                ? slice
                : { ...slice, items: uniqueItems },
        );
    }

    const interstitials: FeedInterstitialSlot[] = [];
    const seenSlotKeys = new Set<string>();
    const validAnchors = slices.length > 0
        ? new Set(slices.map((slice) => slice._sliceKey))
        : new Set(items.map(getItemKey));

    for (const slot of [
        ...(accumulated?.interstitials ?? []),
        ...(incoming.interstitials ?? []),
    ]) {
        if (!slot?.key || seenSlotKeys.has(slot.key)) continue;
        if (!validAnchors.has(slot.afterSliceKey)) continue;
        seenSlotKeys.add(slot.key);
        interstitials.push(slot);
    }

    return {
        items,
        slices: slices.length > 0 ? slices : undefined,
        interstitials: interstitials.length > 0 ? interstitials : undefined,
    };
}

/**
 * Parameters that uniquely identify a feed instance.
 * Two feeds with the same identity render the same items in the same order,
 * so a saved scroll offset (or a cached item slice) is only valid within a
 * single identity.
 */
export interface FeedIdentityParams {
    type: FeedType;
    userId?: string;
    showOnlySaved?: boolean;
    filters?: FeedFilters;
    /**
     * Authenticated viewer that the feed response is authorized for. Feed
     * contents are viewer-dependent, so retained in-memory slices must never
     * be shared across logout/login or account-switch boundaries.
     */
    currentViewerId?: string;
    isAuthenticated?: boolean;
}

/**
 * Deterministically serialize feed filters into a stable string.
 * Keys are sorted so reference-equal-but-reordered objects produce the same
 * output. Mirrors the dedupe-key strategy in `services/feedService.ts` but is
 * defined locally to avoid a service ↔ utils dependency.
 */
function serializeFeedFilters(filters?: FeedFilters): string {
    if (!filters) return '';
    return Object.keys(filters)
        .sort()
        .map((key) => `${key}=${filters[key] ?? ''}`)
        .join('&');
}

/**
 * Build a stable identity key for a feed instance.
 *
 * The same inputs always produce the same key (so scroll offset / cached items
 * restore correctly across an unmount→remount), while distinct feeds (different
 * viewer, type, user, saved view, or filters) produce distinct keys so they never
 * share state. `showOnlySaved` collapses to the `'saved'` effective type, matching
 * the effective-type logic in `useFeedState`.
 */
export function buildFeedScrollKey(params: FeedIdentityParams): string {
    const effectiveType = params.showOnlySaved ? 'saved' : params.type;
    const viewerKey = params.isAuthenticated
        ? `auth:${params.currentViewerId || 'pending'}`
        : 'anon';
    const userId = params.userId ?? '';
    const filterKey = serializeFeedFilters(params.filters);
    return `${viewerKey}|${effectiveType}|${userId}|${filterKey}`;
}

/**
 * Deep equality check for objects/arrays
 * Uses JSON.stringify for simple comparison - optimized for filters
 */
export function deepEqual<T>(a: T, b: T): boolean {
    if (a === b) return true;
    if (a == null || b == null) return false;
    if (typeof a !== 'object' || typeof b !== 'object') return false;

    try {
        return JSON.stringify(a) === JSON.stringify(b);
    } catch {
        // If JSON.stringify fails, fall back to reference equality
        return false;
    }
}

/**
 * Shallow, one-level equality for {@link FeedFilters}.
 *
 * Feed filters are a FLAT bag of primitive scalars (type/hashtag/topic/postId/
 * searchQuery/…), so a single pass of key-by-key `===` is both correct and far
 * cheaper than `JSON.stringify`-based comparison on the per-render Feed path.
 * Callers frequently rebuild the filters object inline (a fresh reference with
 * identical contents every render); this lets `React.memo` and the dep-compare
 * hooks treat those as equal without serializing on every render.
 */
export function shallowFiltersEqual(a?: FeedFilters, b?: FeedFilters): boolean {
    if (a === b) return true;
    if (!a || !b) return false;

    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) return false;

    for (const key of aKeys) {
        if (a[key] !== b[key]) return false;
    }
    return true;
}

/**
 * Cheap equality for a feed's `items`/`slices` array, used to decide whether the
 * `buildFeedRows` memo on the render hot path must recompute.
 *
 * `buildFeedRows` only needs to re-run when the SET / ORDER / membership of rows
 * changes (add / remove / reorder). It does NOT need to re-run when a single
 * post's content mutates (likes, replies, boosts): `PostItem` reads its live post
 * from the store keyed on `dataVersion` (`viewPost = getPostFromDb(id) ?? post`),
 * so per-post updates reach the rendered row independently of this memo.
 *
 * Both feed data paths also allocate a NEW top-level array reference precisely
 * when the underlying data changes (SQLite re-`.map`s rows on each `dataVersion`;
 * memory mode replaces the array on every setter), so the reference short-circuit
 * safely catches the common "re-render, same data" case. For changed references,
 * a full key-by-key pass is still cheap relative to rebuilding rows, and is required
 * to detect same-length interior replacements / reorders without stale row sets.
 */
export function feedArrayEqual<T>(
    a: readonly T[] | undefined,
    b: readonly T[] | undefined,
    keyOf: (item: T) => string,
): boolean {
    if (a === b) return true;
    if (!a || !b) return false;
    if (a.length !== b.length) return false;

    for (let i = 0; i < a.length; i++) {
        if (keyOf(a[i]) !== keyOf(b[i])) return false;
    }

    return true;
}

/**
 * Element key for {@link feedArrayEqual}'s ordered-key comparison that works for the
 * THREE feed array shapes: a `FeedPostSlice` (keyed by its deterministic
 * `_sliceKey`), a `FeedInterstitialSlot` (keyed by its server-issued `key`, which
 * encodes the card's kind and anchor), and a hydrated post item (keyed by
 * {@link getItemKey}). Each is detected by its discriminating field; anything else
 * falls back to the post key.
 */
function feedElementKey(element: unknown): string {
    if (element && typeof element === 'object') {
        if ('_sliceKey' in element) {
            const sliceKey = (element as { _sliceKey?: unknown })._sliceKey;
            if (typeof sliceKey === 'string' && sliceKey) return sliceKey;
        }
        if ('afterSliceKey' in element) {
            const slotKey = (element as { key?: unknown }).key;
            if (typeof slotKey === 'string' && slotKey) return slotKey;
        }
    }
    return getItemKey(element);
}

/**
 * Cheap element-wise equality for a React dependency list, replacing the
 * per-render `JSON.stringify` deep compare on the Feed render path.
 *
 * Each element is compared by its runtime type:
 *  - Arrays (the feed `items`/`slices`): {@link feedArrayEqual} — a reference
 *    short-circuit plus full ordered-key equality (via {@link feedElementKey}).
 *    Both feed data paths allocate a new array reference on every real change
 *    (see {@link feedArrayEqual}), so the reference path is the common fast path.
 *  - `Set`/`Map` (e.g. the privacy `blockedSet`): reference — the owning store
 *    allocates a new instance only when membership changes, so reference equality
 *    is both correct and far cheaper than serializing (the old path stringified a
 *    Set to `{}` and never detected its changes at all).
 *  - Plain objects (e.g. `filters`): one shallow key-by-key pass, so a
 *    rebuilt-but-identical object never falsely invalidates.
 *  - Primitives: `===`.
 */
export function depsShallowEqual(a: DependencyList, b: DependencyList): boolean {
    if (a === b) return true;
    if (a.length !== b.length) return false;

    for (let i = 0; i < a.length; i++) {
        const prev = a[i];
        const next = b[i];
        if (prev === next) continue;

        if (Array.isArray(prev) && Array.isArray(next)) {
            if (!feedArrayEqual(prev, next, feedElementKey)) return false;
            continue;
        }

        if (
            prev !== null &&
            next !== null &&
            typeof prev === 'object' &&
            typeof next === 'object' &&
            !Array.isArray(prev) &&
            !Array.isArray(next) &&
            !(prev instanceof Set) &&
            !(next instanceof Set) &&
            !(prev instanceof Map) &&
            !(next instanceof Map)
        ) {
            // Both are plain objects (filters-like bags): one shallow pass.
            const prevObj = prev as Record<string, unknown>;
            const nextObj = next as Record<string, unknown>;
            const prevKeys = Object.keys(prevObj);
            const nextKeys = Object.keys(nextObj);
            if (prevKeys.length !== nextKeys.length) return false;
            for (const key of prevKeys) {
                if (prevObj[key] !== nextObj[key]) return false;
            }
            continue;
        }

        // Sets / Maps / mismatched types that already failed `===`: a new
        // reference means a real change → not equal.
        return false;
    }
    return true;
}

/**
 * Node in a reply tree, used for threaded display. A reply IS a post — the
 * threaded view is built from the same hydrated posts every other feed row
 * renders — so the tree carries them unchanged.
 */
export interface ReplyNode {
    reply: HydratedPost;
    children: ReplyNode[];
}

/**
 * Build a tree of replies from a flat list.
 * Top-level replies have parentPostId === postId.
 * Nested replies have parentPostId pointing to another reply.
 *
 * Nodes are keyed by {@link getItemKey}, the same key the rendered rows use, so
 * the tree and the rows built from it can never disagree about a post's identity.
 */
export function buildReplyTree(replies: readonly HydratedPost[], postId: string): ReplyNode[] {
    const replyMap = new Map<string, ReplyNode>();
    for (const reply of replies) {
        replyMap.set(getItemKey(reply), { reply, children: [] });
    }

    const topLevel: ReplyNode[] = [];
    for (const reply of replies) {
        const node = replyMap.get(getItemKey(reply));
        if (!node) continue;

        // A reply hangs off its parent only when that parent is in THIS batch and
        // is not the thread root; everything else is a top-level reply.
        const parentId = reply.parentPostId ?? '';
        const parentNode = parentId === postId ? undefined : replyMap.get(parentId);
        if (parentNode) {
            parentNode.children.push(node);
        } else {
            topLevel.push(node);
        }
    }

    return topLevel;
}

/**
 * Deduplicate items using Map for O(1) lookups
 */
export function deduplicateItems<T>(
    items: T[],
    getKey: (item: T) => string = getItemKey
): T[] {
    if (items.length === 0) return [];
    
    const seen = new Map<string, T>();
    for (const item of items) {
        const key = getKey(item);
        if (key && !seen.has(key)) {
            seen.set(key, item);
        }
    }
    
    return Array.from(seen.values());
}
