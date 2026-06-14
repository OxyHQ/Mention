/**
 * Feed utility functions
 * Shared utilities for feed normalization, deduplication, and type safety
 */

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

