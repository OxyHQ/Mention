import mongoose from 'mongoose';
import FeedSession, { IFeedSession } from '../models/FeedSession';

/**
 * Cursor structure for pagination
 * Now includes optional sessionId for database-backed feed sessions
 */
export interface PaginationCursor {
  /** Last seen post ID for chronological pagination */
  _id: string;
  /** Feed session ID for database-backed duplicate tracking */
  sessionId?: string;
  /** Optional timestamp for time-based pagination */
  timestamp?: number;
}

/**
 * Pagination options
 */
export interface PaginationOptions {
  /** Current page cursor (encoded) */
  cursor?: string;
  /** Feed session ID (for database-backed tracking) */
  sessionId?: string;
  /** Number of items per page */
  limit: number;
  /** Whether this feed uses ranking (needs duplicate tracking) */
  useRanking?: boolean;
  /** User ID for feed session association */
  userId?: string;
  /** Feed type for session tracking */
  feedType?: string;
  /** Feed filters for session matching */
  feedFilters?: Record<string, any>;
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
  /** Feed session ID (for database-backed tracking) */
  sessionId?: string;
  /** Total count of items returned */
  totalCount: number;
}

/**
 * CursorPaginationService - Unified pagination service for all feeds
 * 
 * Features:
 * - Simple chronological pagination for standard feeds
 * - Database-backed feed sessions for ranked feeds (no cursor size limits)
 * - Persistent duplicate tracking across page reloads
 * - Support for feed algorithm experiments and analytics
 * - Efficient MongoDB query building
 * - Secure cursor encoding/decoding
 * - Automatic session cleanup (24-hour TTL)
 */
export class CursorPaginationService {
  private readonly DEFAULT_LIMIT = 20;
  private readonly MAX_LIMIT = 100;
  private readonly SESSION_DURATION_HOURS = 24;

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
        sessionId: parsed.sessionId,
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
   * Get or create feed session for ranked feeds
   */
  async getOrCreateFeedSession(
    sessionId: string | undefined,
    userId: string | undefined,
    feedType: string,
    feedFilters?: Record<string, any>
  ): Promise<IFeedSession | null> {
    try {
      return await FeedSession.getOrCreateSession(sessionId, userId, feedType, feedFilters);
    } catch (error) {
      console.error('Failed to get/create feed session:', error);
      return null;
    }
  }

  /**
   * Build MongoDB query conditions for cursor-based pagination
   * 
   * For ranked feeds: Uses database-backed feed session to track seen posts
   * For chronological feeds: Uses simple cursor position only
   * 
   * @param cursor Parsed cursor object
   * @param baseMatch Base MongoDB match conditions
   * @param options Pagination options including feed session
   * @returns Modified match conditions with cursor filters
   */
  async buildCursorQuery(
    cursor: PaginationCursor | null,
    baseMatch: any,
    options: {
      useRanking?: boolean;
      feedSession?: IFeedSession | null;
    } = {}
  ): Promise<any> {
    if (!cursor) return baseMatch;

    const match = { ...baseMatch };
    const idConditions: any[] = [];

    // Add cursor position filter (always present)
    if (cursor._id) {
      idConditions.push({ _id: { $lt: new mongoose.Types.ObjectId(cursor._id) } });
    }

    // For ranked feeds: Use database-backed feed session to exclude seen posts
    if (options.useRanking && options.feedSession) {
      const seenPostIds = options.feedSession.seenPostIds || [];
      
      if (seenPostIds.length > 0) {
        // Optimize: validate and convert in single pass, filter out invalid IDs
        const seenObjectIds = seenPostIds
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
   * For ranked feeds: Updates database feed session with newly loaded posts
   * For chronological feeds: Returns simple cursor with last post ID
   * 
   * @param allItems All items fetched (limit + 1 to check hasMore)
   * @param limit Items per page
   * @param options Pagination options including feed session
   * @returns Pagination result with items and next cursor
   */
  async createPaginationResult<T extends { _id: any }>(
    allItems: T[],
    limit: number,
    options: {
      useRanking?: boolean;
      feedSession?: IFeedSession | null;
    } = {}
  ): Promise<PaginationResult<T>> {
    const hasMore = allItems.length > limit;
    const items = hasMore ? allItems.slice(0, limit) : allItems;
    
    let nextCursor: string | undefined;
    let sessionId: string | undefined;
    
    if (hasMore && items.length > 0) {
      const lastItem = items[items.length - 1];
      const cursorData: PaginationCursor = {
        _id: lastItem._id.toString()
      };

      // For ranked feeds with database session: Update session and include sessionId in cursor
      if (options.useRanking && options.feedSession) {
        // Add newly loaded post IDs to session
        const postIds = items.map(item => item._id.toString());
        await options.feedSession.addSeenPosts(postIds);
        await options.feedSession.updateCursor(lastItem._id.toString());
        
        cursorData.sessionId = options.feedSession.sessionId;
        sessionId = options.feedSession.sessionId;
      }

      nextCursor = this.encodeCursor(cursorData);
    }

    return {
      items,
      hasMore,
      nextCursor,
      sessionId,
      totalCount: items.length
    };
  }

  /**
   * Normalize and validate pagination options
   */
  normalizePaginationOptions(options: Partial<PaginationOptions>): Required<Omit<PaginationOptions, 'sessionId' | 'userId' | 'feedType' | 'feedFilters'>> & Pick<PaginationOptions, 'sessionId' | 'userId' | 'feedType' | 'feedFilters'> {
    return {
      cursor: options.cursor,
      sessionId: options.sessionId,
      limit: Math.min(Math.max(options.limit || this.DEFAULT_LIMIT, 1), this.MAX_LIMIT),
      useRanking: options.useRanking || false,
      userId: options.userId,
      feedType: options.feedType,
      feedFilters: options.feedFilters
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
