/**
 * Feed utility functions for backend
 * Centralized utilities for deduplication, limit validation, filter parsing, and cursor handling
 */

import mongoose from 'mongoose';
import { FeedFilters } from '@mention/shared-types';
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
 * Validate and normalize limit parameter
 * Ensures limit is within acceptable bounds
 * Handles string, number, and Express ParsedQs types
 */
export function validateAndNormalizeLimit(
  requestedLimit: string | number | any | undefined,
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
 * Parse feed filters from request query parameters
 * Handles both JSON string and object formats, as well as filters[] prefix format
 */
export function parseFeedFilters(reqQuery: any): Record<string, unknown> {
  let filters: Record<string, unknown> | undefined = reqQuery.filters as Record<string, unknown> | undefined;

  // Parse filters if it's a string
  if (typeof filters === 'string') {
    try {
      filters = JSON.parse(filters) as Record<string, unknown>;
    } catch (e) {
      logger.warn('Failed to parse filters JSON', e);
      filters = {} as Record<string, unknown>;
    }
  }

  // If filters is not an object, try to parse from query params with filters[] prefix
  if (!filters || typeof filters !== 'object' || Array.isArray(filters)) {
    filters = {} as Record<string, unknown>;
    // Extract all query params that start with 'filters['
    Object.keys(reqQuery).forEach(key => {
      if (key.startsWith('filters[') && key.endsWith(']')) {
        const filterKey = key.slice(8, -1); // Remove 'filters[' and ']'
        if (filters) {
          filters[filterKey] = reqQuery[key];
        }
      }
    });
  }

  return filters || {};
}

/**
 * Validate and parse cursor for pagination
 * Returns ObjectId if valid, undefined otherwise
 */
export function parseFeedCursor(cursor: string | undefined): mongoose.Types.ObjectId | undefined {
  if (!cursor) return undefined;
  
  try {
    if (mongoose.Types.ObjectId.isValid(cursor)) {
      return new mongoose.Types.ObjectId(cursor);
    } else {
      logger.warn('Invalid cursor format', cursor);
      return undefined;
    }
  } catch (error) {
    logger.warn('Error parsing cursor', { cursor, error });
    return undefined;
  }
}

/**
 * Build cursor from post ID
 * Returns string representation of ObjectId for cursor-based pagination
 */
export function buildFeedCursor(post: { _id?: mongoose.Types.ObjectId | string; id?: string }): string | undefined {
  const rawId = post._id || post.id;
  if (!rawId) return undefined;

  try {
    return rawId instanceof mongoose.Types.ObjectId
      ? rawId.toString()
      : String(rawId);
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
export function deduplicatePosts<T extends { _id?: mongoose.Types.ObjectId | string; id?: string }>(
  posts: T[]
): T[] {
  if (posts.length === 0) return [];

  const seen = new Map<string, T>();
  
  for (const post of posts) {
    let id: string | undefined;
    
    // Try _id first (MongoDB format)
    if (post._id) {
      id = post._id instanceof mongoose.Types.ObjectId
        ? post._id.toString()
        : String(post._id);
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

/**
 * Apply query optimizations (timeout, result size validation)
 */
export function applyQueryOptimizations<T>(query: any, maxResults?: number): any {
  // Add query timeout
  query.maxTimeMS(FEED_CONSTANTS.QUERY_TIMEOUT_MS);
  return query;
}

