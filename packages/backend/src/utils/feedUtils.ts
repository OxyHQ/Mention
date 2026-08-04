/**
 * Feed utility functions for backend
 * Centralized utilities for deduplication, limit validation, filter parsing, and cursor handling
 */

import { logger } from './logger';

/**
 * Default feed configuration constants
 */
export const FEED_CONSTANTS = {
  DEFAULT_LIMIT: 20,
  MIN_LIMIT: 1,
  MAX_LIMIT: 200,
  QUERY_TIMEOUT_MS: 5000,
  MAX_QUERY_RESULT_SIZE: 10000,
} as const;

/**
 * Progressive recency windows (milliseconds) for the popular/engagement
 * discovery scans. A bounded `createdAt >= now - window` match lets the planner
 * use the `{ visibility, status, createdAt }` index instead of scanning the
 * whole collection. Ordered narrowest → widest; {@link fetchWithRecencyFallback}
 * widens through them and finally drops the bound entirely so a sparse instance
 * is NEVER served a blank/short page.
 */
export const FEED_RECENCY_WINDOWS_MS: readonly number[] = [
  7 * 24 * 60 * 60 * 1000, // 7 days
  30 * 24 * 60 * 60 * 1000, // 30 days
];

/**
 * Run an engagement/popular query under progressively wider recency windows,
 * returning the first window whose result fills the requested page. The cutoff
 * is computed per-call (never at module scope) and passed to `runWithCutoff`;
 * the final pass receives `undefined` (no time bound) as the never-blank
 * fallback, so the result is at most `FEED_RECENCY_WINDOWS_MS.length + 1`
 * queries and is only more than one when the narrower windows underfill.
 *
 * @param desiredCount minimum rows for a window to be accepted (typically the
 *   overfetch size, `limit + 1`).
 * @param runWithCutoff executes the scan for a given cutoff Date, or unbounded
 *   when `undefined`.
 */
export async function fetchWithRecencyFallback<T>(
  desiredCount: number,
  runWithCutoff: (cutoff: Date | undefined) => Promise<T[]>,
): Promise<T[]> {
  const now = Date.now();
  for (const windowMs of FEED_RECENCY_WINDOWS_MS) {
    const result = await runWithCutoff(new Date(now - windowMs));
    if (result.length >= desiredCount) {
      return result;
    }
  }
  // Never-blank fallback: no time bound — return whatever exists.
  return runWithCutoff(undefined);
}

/**
 * Validate and normalize limit parameter
 * Ensures limit is within acceptable bounds
 * Handles string, number, and Express ParsedQs types
 */
export function validateAndNormalizeLimit(
  requestedLimit: unknown,
  defaultLimit: number = FEED_CONSTANTS.DEFAULT_LIMIT
): number {
  // Handle Express ParsedQs and other types
  let limitValue: string | number | undefined;
  if (typeof requestedLimit === 'string') {
    limitValue = parseInt(requestedLimit, 10);
  } else if (typeof requestedLimit === 'number') {
    limitValue = requestedLimit;
  } else {
    limitValue = undefined;
  }
  
  const parsedLimit = Number.isNaN(limitValue) ? defaultLimit : (limitValue ?? defaultLimit);
  
  if (Number.isNaN(parsedLimit) || parsedLimit === undefined) {
    return defaultLimit;
  }
  
  return Math.min(
    Math.max(parsedLimit, FEED_CONSTANTS.MIN_LIMIT),
    FEED_CONSTANTS.MAX_LIMIT
  );
}

/**
 * Build cursor from post ID.
 *
 * `String(...)` rather than an `instanceof mongoose.Types.ObjectId` branch: the
 * two were always equivalent — `String(obj)` invokes `obj.toString()`, which for
 * an ObjectId is the same 24-hex — so the branch cost a runtime Mongoose import
 * to express what the coercion already did. Post ids are `posts.id`, a `text`
 * column holding ObjectId hex before the cutover and uuid v7 after; neither is
 * an ObjectId instance by the time it reaches here.
 */
export function buildFeedCursor(post: { _id?: string; id?: string }): string | undefined {
  const rawId = post._id || post.id;
  if (!rawId) return undefined;

  try {
    return String(rawId);
  } catch (error) {
    logger.warn('Error building cursor', { postId: rawId, error });
    return undefined;
  }
}

/**
 * Validate cursor advanced (prevent infinite loops)
 * Returns true if cursor has advanced, false if it's the same
 */
export function validateCursorAdvanced(
  newCursor: string | undefined,
  previousCursor: string | undefined
): boolean {
  if (!newCursor || !previousCursor) return true; // First page or no cursor
  return newCursor !== previousCursor;
}

/**
 * Deduplicate posts by ID
 * Uses Map for O(1) lookups, handles both _id and id fields
 */
export function deduplicatePosts<T extends { _id?: string; id?: string }>(
  posts: T[]
): T[] {
  if (posts.length === 0) return [];

  const seen = new Map<string, T>();
  
  for (const post of posts) {
    let id: string | undefined;
    
    // Try _id first (MongoDB format)
    if (post._id) {
      id = String(post._id);
    }
    // Fallback to id field
    else if (post.id) {
      id = String(post.id);
    }
    
    if (id && id !== 'undefined' && id !== 'null' && !seen.has(id)) {
      seen.set(id, post);
    }
  }

  return Array.from(seen.values());
}

/**
 * Validate query result size to prevent memory issues
 */
export function validateResultSize<T>(
  results: T[],
  maxSize: number = FEED_CONSTANTS.MAX_QUERY_RESULT_SIZE
): void {
  if (results.length > maxSize) {
    logger.error(`Query result size ${results.length} exceeds maximum ${maxSize}`);
    throw new Error(`Query result size exceeds maximum allowed size of ${maxSize}`);
  }
}
