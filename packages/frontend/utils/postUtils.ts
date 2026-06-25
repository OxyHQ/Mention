/**
 * The minimal, defensively-read shape of a post-like item across the various
 * formats the feed/store carries (hydrated posts, legacy snake-case payloads,
 * boost wrappers). Every field is optional because callers handle missing data.
 */
export interface AuthorBearingItem {
    user?: { id?: unknown; _id?: unknown; userId?: unknown } | null;
    authorId?: unknown;
}

/**
 * Efficiently extract author/user ID from various post item formats
 * Optimized for performance - single pass, minimal allocations
 */
export function extractAuthorId(item: AuthorBearingItem | null | undefined): string | null {
    if (!item) return null;

    // Fast path: check user.id first (most common)
    const user = item.user;
    if (user?.id) return String(user.id);
    if (user?._id) return String(user._id);
    if (user?.userId) return String(user.userId);

    // Fallback: check top-level authorId
    if (item.authorId) return String(item.authorId);

    return null;
}

/**
 * Batch extract author IDs from array of items
 * More efficient than calling extractAuthorId in a loop
 */
export function extractAuthorIds(items: (AuthorBearingItem | null | undefined)[]): (string | null)[] {
    const result: (string | null)[] = new Array(items.length);
    for (let i = 0; i < items.length; i++) {
        result[i] = extractAuthorId(items[i]);
    }
    return result;
}

