import mongoose from 'mongoose';

/**
 * Cursor structure for pagination
 * Supports both simple (chronological) and complex (ranked with seen IDs) cursors
 */
export interface PaginationCursor {
  /** Last seen post ID for chronological pagination */
  _id: string;
  /** Array of seen post IDs to prevent duplicates in ranked feeds */
  seenIds?: string[];
  /** Optional timestamp for time-based pagination */
  timestamp?: number;
}

/**
 * Pagination options
 */
export interface PaginationOptions {
  /** Current page cursor (encoded) */
  cursor?: string;
  /** Number of items per page */
  limit: number;
  /** Whether this feed uses ranking (needs duplicate tracking) */
  useRanking?: boolean;
  /** Maximum number of seen IDs to track (default: 200) */
  maxSeenIds?: number;
}

/**
 * Pagination result
 */
export interface PaginationResult<T> {
  /** Items for current page */
  items: T[];
  /** Whether more items exist */
  hasMore: boolean;
  /** Encoded cursor for next page */
  nextCursor?: string;
  /** Total count of items returned */
  totalCount: number;
}

/**
 * CursorPaginationService - Unified pagination service for all feeds
 * 
 * Features:
 * - Simple chronological pagination for standard feeds
 * - Advanced pagination with duplicate tracking for ranked feeds
 * - Efficient MongoDB query building
 * - Secure cursor encoding/decoding
 * - Performance optimizations
 */
export class CursorPaginationService {
  private readonly DEFAULT_LIMIT = 20;
  private readonly MAX_LIMIT = 100;
  private readonly DEFAULT_MAX_SEEN_IDS = 200;

  /**
   * Parse and validate cursor from request
   */
  parseCursor(cursorString?: string): PaginationCursor | null {
    if (!cursorString) return null;

    try {
      // Try to decode as base64 JSON (compound cursor)
      const decoded = Buffer.from(cursorString, 'base64').toString('utf-8');
      const parsed = JSON.parse(decoded);
      
      if (!parsed._id) {
        throw new Error('Invalid cursor: missing _id');
      }

      // Validate ObjectId format
      if (!mongoose.Types.ObjectId.isValid(parsed._id)) {
        throw new Error('Invalid cursor: invalid _id format');
      }

      return {
        _id: parsed._id,
        seenIds: Array.isArray(parsed.seenIds) ? parsed.seenIds : undefined,
        timestamp: typeof parsed.timestamp === 'number' ? parsed.timestamp : undefined
      };
    } catch (error) {
      // Fallback: treat as simple ObjectId cursor (backward compatibility)
      if (mongoose.Types.ObjectId.isValid(cursorString)) {
        return { _id: cursorString };
      }
      
      // Invalid cursor - return null and let caller handle
      if (process.env.NODE_ENV === 'development') {
        console.warn('Invalid cursor format:', error instanceof Error ? error.message : 'Parse error');
      }
      return null;
    }
  }

  /**
   * Encode cursor for next page
   */
  encodeCursor(cursor: PaginationCursor): string {
    return Buffer.from(JSON.stringify(cursor)).toString('base64');
  }

  /**
   * Build MongoDB query conditions for cursor-based pagination
   * 
   * @param cursor Parsed cursor object
   * @param baseMatch Base MongoDB match conditions
   * @param options Pagination options
   * @returns Modified match conditions with cursor filters
   */
  buildCursorQuery(
    cursor: PaginationCursor | null,
    baseMatch: any,
    options: { useRanking?: boolean } = {}
  ): any {
    if (!cursor) return baseMatch;

    const match = { ...baseMatch };
    const idConditions: any[] = [];

    // Add cursor position filter (always present)
    if (cursor._id) {
      idConditions.push({ _id: { $lt: new mongoose.Types.ObjectId(cursor._id) } });
    }

    // Add seen IDs exclusion for ranked feeds
    if (options.useRanking && cursor.seenIds && cursor.seenIds.length > 0) {
      // Optimize: validate and convert in single pass, filter out invalid IDs
      const seenObjectIds = cursor.seenIds
        .map(id => {
          try {
            return mongoose.Types.ObjectId.isValid(id) ? new mongoose.Types.ObjectId(id) : null;
          } catch {
            return null;
          }
        })
        .filter((id): id is mongoose.Types.ObjectId => id !== null);

      if (seenObjectIds.length > 0) {
        idConditions.push({ _id: { $nin: seenObjectIds } });
      }
    }

    // Combine conditions using $and
    if (idConditions.length > 0) {
      match.$and = match.$and || [];
      match.$and.push(...idConditions);
    }

    return match;
  }

  /**
   * Create pagination result with cursor for next page
   * 
   * @param allItems All items fetched (limit + 1 to check hasMore)
   * @param limit Items per page
   * @param options Pagination options
   * @returns Pagination result with items and next cursor
   * 
   * Note: For ranked feeds with seen IDs tracking, the seenIds array is limited
   * to maxSeenIds (default: 200) most recent IDs. This is a performance trade-off:
   * - Pros: Prevents cursor from growing unbounded, maintains good performance
   * - Cons: Posts older than the tracking window may theoretically reappear
   * - In practice: Rare occurrence during very long scrolling sessions (>200 posts)
   * - Mitigation: Client-side deduplication provides additional safety
   */
  createPaginationResult<T extends { _id: any }>(
    allItems: T[],
    limit: number,
    options: {
      useRanking?: boolean;
      previousSeenIds?: string[];
      maxSeenIds?: number;
    } = {}
  ): PaginationResult<T> {
    const hasMore = allItems.length > limit;
    const items = hasMore ? allItems.slice(0, limit) : allItems;
    
    let nextCursor: string | undefined;
    
    if (hasMore && items.length > 0) {
      const lastItem = items[items.length - 1];
      const cursorData: PaginationCursor = {
        _id: lastItem._id.toString()
      };

      // For ranked feeds, track all seen IDs
      if (options.useRanking) {
        const currentPageIds = items.map(item => item._id.toString());
        const allSeenIds = [
          ...(options.previousSeenIds || []),
          ...currentPageIds
        ];

        // Limit seen IDs to prevent cursor from growing too large
        // Keep most recent IDs for better duplicate prevention during active scrolling
        // Note: This is a trade-off between cursor size and duplicate prevention
        // Older posts that scroll out of this window may reappear, but this is acceptable
        // for the performance benefit and is rare in practice
        const maxSeenIds = options.maxSeenIds || this.DEFAULT_MAX_SEEN_IDS;
        cursorData.seenIds = allSeenIds.slice(-maxSeenIds);
      }

      nextCursor = this.encodeCursor(cursorData);
    }

    return {
      items,
      hasMore,
      nextCursor,
      totalCount: items.length
    };
  }

  /**
   * Validate and normalize pagination options
   */
  normalizePaginationOptions(options: Partial<PaginationOptions>): Required<PaginationOptions> {
    return {
      cursor: options.cursor,
      limit: Math.min(Math.max(options.limit || this.DEFAULT_LIMIT, 1), this.MAX_LIMIT),
      useRanking: options.useRanking || false,
      maxSeenIds: options.maxSeenIds || this.DEFAULT_MAX_SEEN_IDS
    };
  }

  /**
   * Deduplicate items by _id (safety measure for ranked feeds)
   */
  deduplicateById<T extends { _id: any }>(items: T[]): T[] {
    const seen = new Set<string>();
    return items.filter(item => {
      const id = item._id.toString();
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
  }
}

// Singleton instance
export const cursorPaginationService = new CursorPaginationService();
