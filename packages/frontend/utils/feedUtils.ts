/**
 * Feed utility functions
 * Shared utilities for feed normalization, deduplication, and type safety
 */

import { FeedItem, FeedType } from '@mention/shared-types';

/**
 * Normalize item ID for consistent deduplication
 * Handles various ID formats: id, _id, _id_str, postId, post.id, post._id
 */
export function normalizeItemId(item: FeedItem | any): string {
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
export function getItemKey(item: FeedItem | any): string {
    const normalizedId = normalizeItemId(item);
    
    if (normalizedId && normalizedId !== 'undefined' && normalizedId !== 'null' && normalizedId !== '') {
        return normalizedId;
    }
    
    // Fallback to username or JSON stringification as last resort
    const fallback = item?.username || JSON.stringify(item);
    return String(fallback);
}

/**
 * Feed filter interface
 */
export interface FeedFilters {
    searchQuery?: string;
    postId?: string;
    parentPostId?: string;
    customFeedId?: string;
    [key: string]: any;
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
 * Deduplicate items using Map for O(1) lookups
 */
export function deduplicateItems<T extends FeedItem | any>(
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

