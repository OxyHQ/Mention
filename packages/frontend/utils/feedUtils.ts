/**
 * Feed utility functions
 * Shared utilities for feed normalization, deduplication, and type safety
 */

import type { DependencyList } from 'react';
import { FeedType, FeedFilters as SharedFeedFilters } from '@mention/shared-types';

// Extended FeedFilters with additional properties used by the app
export interface FeedFilters extends SharedFeedFilters {
    searchQuery?: string;
    postId?: string;
    parentPostId?: string;
    customFeedId?: string;
    hashtag?: string;
    topic?: string;
    [key: string]: any;
}

/**
 * Normalize item ID for consistent deduplication
 * Handles various ID formats: id, _id, _id_str, postId, post.id, post._id
 */
export function normalizeItemId(item: any): string {
    if (item?.id) return String(item.id);
    if (item?._id) {
        const _id = item._id;
        return typeof _id === 'object' && typeof _id.toString === 'function'
            ? _id.toString()
            : String(_id);
    }
    if (item?._id_str) return String(item._id_str);
    if (item?.postId) return String(item.postId);
    if (item?.post?.id) return String(item.post.id);
    if (item?.post?._id) {
        const _id = item.post._id;
        return typeof _id === 'object' && typeof _id.toString === 'function'
            ? _id.toString()
            : String(_id);
    }
    return '';
}

/**
 * Extract item key using normalization
 */
export function getItemKey(item: any): string {
    const normalizedId = normalizeItemId(item);
    
    if (normalizedId && normalizedId !== 'undefined' && normalizedId !== 'null' && normalizedId !== '') {
        return normalizedId;
    }
    
    // Fallback to username or JSON stringification as last resort
    const fallback = item?.username || JSON.stringify(item);
    return String(fallback);
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
 * type, user, saved view, or filters) produce distinct keys so they never share
 * state. `showOnlySaved` collapses to the `'saved'` effective type, matching the
 * effective-type logic in `useFeedState`.
 */
export function buildFeedScrollKey(params: FeedIdentityParams): string {
    const effectiveType = params.showOnlySaved ? 'saved' : params.type;
    const userId = params.userId ?? '';
    const filterKey = serializeFeedFilters(params.filters);
    return `${effectiveType}|${userId}|${filterKey}`;
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
 * a length + head/middle/tail-key signature detects any add / remove / reorder
 * (mirrors the native `dataHash` first/mid/last sampling) — so a real structural
 * change is never missed and the feed can never silently blank.
 */
export function feedArrayEqual<T>(
    a: readonly T[] | undefined,
    b: readonly T[] | undefined,
    keyOf: (item: T) => string,
): boolean {
    if (a === b) return true;
    if (!a || !b) return false;
    if (a.length !== b.length) return false;
    if (a.length === 0) return true;
    const last = a.length - 1;
    const mid = last >> 1;
    return (
        keyOf(a[0]) === keyOf(b[0]) &&
        keyOf(a[mid]) === keyOf(b[mid]) &&
        keyOf(a[last]) === keyOf(b[last])
    );
}

/**
 * Element key for {@link feedArrayEqual}'s boundary signature that works for BOTH
 * feed array shapes: a {@link FeedPostSlice} (keyed by its deterministic
 * `_sliceKey`) and a hydrated post item (keyed by {@link getItemKey}). A slice is
 * detected by its `_sliceKey` field; everything else falls back to the post key.
 */
function feedElementKey(element: unknown): string {
    if (element && typeof element === 'object' && '_sliceKey' in element) {
        const sliceKey = (element as { _sliceKey?: unknown })._sliceKey;
        if (typeof sliceKey === 'string' && sliceKey) return sliceKey;
    }
    return getItemKey(element);
}

/**
 * Cheap element-wise equality for a React dependency list, replacing the
 * per-render `JSON.stringify` deep compare on the Feed render path.
 *
 * Each element is compared by its runtime type:
 *  - Arrays (the feed `items`/`slices`): {@link feedArrayEqual} — a reference
 *    short-circuit plus a length + head/tail-key signature (via
 *    {@link feedElementKey}). Both feed data paths allocate a new array reference
 *    on every real change (see {@link feedArrayEqual}), so the reference path is
 *    correct; the signature is a defensive backstop so the feed can never blank.
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
 * Node in a reply tree, used for threaded display
 */
export interface ReplyNode {
    reply: any;
    children: ReplyNode[];
}

/**
 * Build a tree of replies from a flat list.
 * Top-level replies have parentPostId === postId.
 * Nested replies have parentPostId pointing to another reply.
 */
export function buildReplyTree(replies: any[], postId: string): ReplyNode[] {
    const replyMap = new Map<string, ReplyNode>();
    const topLevel: ReplyNode[] = [];

    for (const reply of replies) {
        const id = String(reply.id || reply._id);
        replyMap.set(id, { reply, children: [] });
    }

    for (const reply of replies) {
        const id = String(reply.id || reply._id);
        const parentId = String(reply.parentPostId || '');
        const node = replyMap.get(id)!;

        if (parentId === postId || !replyMap.has(parentId)) {
            topLevel.push(node);
        } else {
            const parentNode = replyMap.get(parentId);
            if (parentNode) {
                parentNode.children.push(node);
            } else {
                topLevel.push(node);
            }
        }
    }

    return topLevel;
}

/**
 * Deduplicate items using Map for O(1) lookups
 */
export function deduplicateItems<T>(
    items: T[],
    getKey: (item: T) => string = getItemKey as (item: T) => string
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

