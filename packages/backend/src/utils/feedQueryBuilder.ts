/**
 * Feed Query Builder
 * Centralized query building logic for feed endpoints
 * Separates query construction from business logic
 */

import { FeedType, PostType, PostVisibility } from '@mention/shared-types';
import mongoose from 'mongoose';
import { ContentLabel } from '../models/ContentLabel';
import { parseFeedCursor } from './feedUtils';
import { ChronoCursor } from '../mtn/feed/CursorBuilder';

export interface FeedQueryOptions {
  type: FeedType;
  filters?: Record<string, unknown>;
  currentUserId?: string;
  cursor?: string;
  limit?: number;
  savedPostIds?: mongoose.Types.ObjectId[];
}

export class FeedQueryBuilder {
  /**
   * Build MongoDB query based on feed type and filters
   */
  static buildQuery(options: FeedQueryOptions): Record<string, unknown> {
    const { type, filters, currentUserId, cursor, savedPostIds } = options;
    
    // Handle saved posts separately
    if (type === 'saved' && savedPostIds && savedPostIds.length > 0) {
      return this.buildSavedPostsQuery(savedPostIds, filters);
    }
    
    // Build base query
    const query = this.buildBaseQuery(type, filters, currentUserId);
    
    // Add cursor for pagination using utility
    const cursorId = parseFeedCursor(cursor);
    if (cursorId) {
      query._id = { $lt: cursorId };
    }
    
    return query;
  }
  
  /**
   * Build base query for feed type
   */
  private static buildBaseQuery(type: FeedType, filters?: Record<string, unknown>, currentUserId?: string): Record<string, unknown> {
    const query: Record<string, unknown> = {
      visibility: PostVisibility.PUBLIC,
      status: 'published'
    };

    // Filter by post type
    switch (type) {
      case 'posts':
        query.type = { $in: [PostType.TEXT, PostType.IMAGE, PostType.VIDEO, PostType.POLL] };
        query.parentPostId = null;
        query.boostOf = null;
        break;
      case 'media': {
        query.$and = [
          { $or: [
            { type: { $in: [PostType.IMAGE, PostType.VIDEO] } },
            { 'content.media.0': { $exists: true } },
            { 'content.images.0': { $exists: true } },
            { 'content.attachments.0': { $exists: true } },
            { 'content.files.0': { $exists: true } },
            { 'media.0': { $exists: true } }
          ] },
          { $or: [{ parentPostId: null }, { parentPostId: { $exists: false } }] },
          { $or: [{ boostOf: null }, { boostOf: { $exists: false } }] }
        ];
        break;
      }
      case 'replies':
        query.parentPostId = { $ne: null };
        break;
      case 'boosts':
        query.boostOf = { $ne: null };
        break;
      case 'mixed':
      default:
        // Show all types
        break;
    }

    // Apply filters
    if (filters) {
      this.applyFilters(query, filters, currentUserId);
    }

    return query;
  }
  
  /**
   * Apply label filtering to exclude posts that match the caller's hidden label subscriptions.
   * Returns sets of post IDs grouped by the action that should be taken on them.
   */
  /** Merge a $nin exclusion into the query's _id filter, creating $and if needed */
  private static excludeIds(query: Record<string, unknown>, ids: string[]): void {
    if (ids.length === 0) return;
    const existing = query._id;
    if (existing && typeof existing === 'object') {
      if (!Array.isArray(query.$and)) {
        query.$and = [];
      }
      (query.$and as unknown[]).push({ _id: { $nin: ids } });
    } else {
      query._id = { $nin: ids };
    }
  }

  static async applyLabelFiltering(
    query: Record<string, unknown>,
    hiddenLabelFilters: Array<{ labelerId: string; labelSlug: string }>
  ): Promise<{ hiddenPostIds: string[]; warnPostIds: string[]; blurPostIds: string[] }> {
    const empty = { hiddenPostIds: [], warnPostIds: [], blurPostIds: [] };
    if (!hiddenLabelFilters || hiddenLabelFilters.length === 0) return empty;

    // Build $or conditions for each (labelerId, labelSlug) pair
    const orConditions = hiddenLabelFilters
      .filter(f => mongoose.Types.ObjectId.isValid(f.labelerId))
      .map(f => ({
        labelerId: new mongoose.Types.ObjectId(f.labelerId),
        labelSlug: f.labelSlug,
      }));

    if (orConditions.length === 0) return empty;

    const matchingLabels = await ContentLabel.find({
      targetType: 'post',
      $or: orConditions,
    }, { targetId: 1, _id: 0 }).limit(200).lean();

    const hiddenPostIds = matchingLabels.map((l) => String(l.targetId));

    this.excludeIds(query, hiddenPostIds);

    return { hiddenPostIds, warnPostIds: [], blurPostIds: [] };
  }

  /**
   * Apply filters to query
   */
  private static applyFilters(
    query: Record<string, unknown>,
    filters: Record<string, unknown>,
    currentUserId?: string
  ): void {
    // Author filter
    if (filters.authors) {
      let authors: string[] = [];
      if (Array.isArray(filters.authors)) {
        authors = filters.authors as string[];
      } else if (typeof filters.authors === 'string') {
        authors = String(filters.authors)
          .split(',')
          .map((s: string) => s.trim())
          .filter(Boolean);
      }
      if (authors.length) {
        query.oxyUserId = { $in: authors };
      } else {
        query.oxyUserId = { $in: [] };
      }
    }
    
    // Exclude owner from custom feeds if explicitly requested
    if (filters.excludeOwner && currentUserId) {
      const oxyUserIdFilter = query.oxyUserId;
      if (oxyUserIdFilter && typeof oxyUserIdFilter === 'object' && '$in' in oxyUserIdFilter && Array.isArray(oxyUserIdFilter.$in)) {
        query.oxyUserId = {
          $in: (oxyUserIdFilter.$in as unknown[]).filter((id) => id !== currentUserId)
        };
      } else {
        query.oxyUserId = { $ne: currentUserId };
      }
    }
    
    if (filters.includeReplies === false) {
      query.parentPostId = { $exists: false };
    }
    if (filters.includeBoosts === false) {
      query.boostOf = { $exists: false };
    }
    if (filters.includeMedia === false) {
      query.type = { $nin: [PostType.IMAGE, PostType.VIDEO] };
    }
    if (filters.includeSensitive === false) {
      query['metadata.isSensitive'] = { $ne: true };
    }
    if (filters.language) {
      query.language = filters.language;
    }
    if (filters.dateFrom) {
      const dateFrom = typeof filters.dateFrom === 'string' || filters.dateFrom instanceof Date 
        ? new Date(filters.dateFrom as string | Date)
        : new Date(String(filters.dateFrom));
      query.createdAt = { $gte: dateFrom };
    }
    if (filters.dateTo) {
      const dateTo = typeof filters.dateTo === 'string' || filters.dateTo instanceof Date
        ? new Date(filters.dateTo as string | Date)
        : new Date(String(filters.dateTo));
      const existingCreatedAt = query.createdAt;
      query.createdAt = existingCreatedAt && typeof existingCreatedAt === 'object'
        ? { ...existingCreatedAt, $lte: dateTo }
        : { $lte: dateTo };
    }
    
    // Parent post filter (for fetching replies to a specific post)
    if (filters.parentPostId) {
      query.parentPostId = String(filters.parentPostId);
    }

    // Exclude specific post IDs (e.g. label-filtered posts)
    if (filters.excludePostIds) {
      const ids = Array.isArray(filters.excludePostIds)
        ? (filters.excludePostIds as string[]).filter(id => mongoose.Types.ObjectId.isValid(id))
        : [];
      this.excludeIds(query, ids);
    }

    // Keywords filter
    if (filters.keywords) {
      const kws = Array.isArray(filters.keywords)
        ? filters.keywords
        : String(filters.keywords).split(',').map((s: string) => s.trim()).filter(Boolean);
      if (kws.length) {
        const regexes = kws.map((k: string) => new RegExp(k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
        const keywordConditions = [
          { 'content.text': { $in: regexes } },
          { hashtags: { $in: kws.map((k: string) => k.toLowerCase()) } }
        ];
        
        if (query.$or) {
          const existingOr = Array.isArray(query.$or) ? query.$or : [query.$or];
          if (!Array.isArray(query.$and)) {
            query.$and = [];
          }
          (query.$and as unknown[]).push({ $or: [...existingOr, ...keywordConditions] });
          delete query.$or;
        } else {
          query.$or = keywordConditions;
        }
      }
    }
  }
  
  /**
   * Build query for saved posts
   */
  private static buildSavedPostsQuery(
    savedPostIds: mongoose.Types.ObjectId[],
    filters?: Record<string, unknown>
  ): Record<string, unknown> {
    const query: Record<string, unknown> = {
      _id: { $in: savedPostIds },
      status: 'published',
    };
    
    // Apply search query filter if provided
    if (filters?.searchQuery) {
      const searchQuery = String(filters.searchQuery).trim();
      if (searchQuery) {
        const escapedQuery = searchQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        query['content.text'] = {
          $regex: escapedQuery,
          $options: 'i'
        };
      }
    }
    
    return query;
  }
  
  /**
   * Build query for For You feed (with seen posts exclusion)
   */
  static buildForYouQuery(
    seenPostIds: string[],
    cursor?: string
  ): Record<string, unknown> {
    const match: Record<string, unknown> = {
      visibility: PostVisibility.PUBLIC,
      status: 'published',
      // No parentPostId filter — replies flow through for thread slicing
      $and: [
        { $or: [{ boostOf: null }, { boostOf: { $exists: false } }] }
      ]
    };

    // Exclude seen posts
    if (seenPostIds.length > 0) {
      const seenObjectIds = seenPostIds
        .filter(id => mongoose.Types.ObjectId.isValid(id))
        .map(id => new mongoose.Types.ObjectId(id));
      
      if (seenObjectIds.length > 0) {
        if (!Array.isArray(match.$and)) {
          match.$and = [];
        }
        (match.$and as unknown[]).push({ _id: { $nin: seenObjectIds } });
      }
    }

    // Apply cursor filter using utility
    const cursorId = parseFeedCursor(cursor);
    if (cursorId) {
      const existingIdFilter = match._id as Record<string, unknown> | undefined;
      if (existingIdFilter && typeof existingIdFilter === 'object' && '$nin' in existingIdFilter) {
        if (!Array.isArray(match.$and)) {
          match.$and = [];
        }
        (match.$and as unknown[]).push({ _id: { $lt: cursorId } });
      } else {
        match._id = { $lt: cursorId };
      }
    }

    return match;
  }
  
  /**
   * Build query for the Videos (Reels) feed.
   *
   * Matches public, published posts that contain at least one video — either a
   * post typed as VIDEO or a post whose content.media array contains a video
   * item. Both native and federated posts are included (no federation
   * exclusion). Boosts are excluded (the underlying original is surfaced
   * instead). Replies flow through so multi-post threads can still be sliced.
   */
  static buildVideosQuery(
    seenPostIds: string[],
    cursor?: string,
  ): Record<string, unknown> {
    const videoMatch = {
      $or: [
        { type: PostType.VIDEO },
        { 'content.media': { $elemMatch: { type: 'video' } } },
      ],
    };

    const match: Record<string, unknown> = {
      visibility: PostVisibility.PUBLIC,
      status: 'published',
      $and: [
        videoMatch,
        { $or: [{ boostOf: null }, { boostOf: { $exists: false } }] },
      ],
    };

    // Exclude already-seen posts (de-prioritize seen content for discovery)
    const seenObjectIds = seenPostIds
      .filter(id => mongoose.Types.ObjectId.isValid(id))
      .map(id => new mongoose.Types.ObjectId(id));
    if (seenObjectIds.length > 0) {
      (match.$and as unknown[]).push({ _id: { $nin: seenObjectIds } });
    }

    const cursorId = parseFeedCursor(cursor);
    if (cursorId) {
      (match.$and as unknown[]).push({ _id: { $lt: cursorId } });
    }

    return match;
  }

  /**
   * Build query for the global Media feed.
   *
   * Mirrors buildVideosQuery but widens the content predicate to ANY media
   * attachment (images, videos or gifs) rather than videos only. Matches
   * public, published posts that are typed as IMAGE/VIDEO, carry at least one
   * item in content.media, or carry a media attachment in content.attachments.
   * Both native and federated posts are included (no federation exclusion).
   * Boosts are excluded (the underlying original is surfaced instead). Replies
   * flow through so multi-post threads can still be sliced.
   *
   * The content.media predicate is backed by the `{ 'content.media': 1,
   * createdAt: -1 }` index; the type predicate is backed by the
   * `{ type: 1, visibility: 1, status: 1, createdAt: -1 }` index.
   */
  static buildMediaFeedQuery(
    seenPostIds: string[],
    cursor?: string,
  ): Record<string, unknown> {
    const mediaMatch = {
      $or: [
        { type: { $in: [PostType.IMAGE, PostType.VIDEO] } },
        { 'content.media.0': { $exists: true } },
        { 'content.attachments': { $elemMatch: { type: 'media' } } },
      ],
    };

    const match: Record<string, unknown> = {
      visibility: PostVisibility.PUBLIC,
      status: 'published',
      $and: [
        mediaMatch,
        { $or: [{ boostOf: null }, { boostOf: { $exists: false } }] },
      ],
    };

    // Exclude already-seen posts (de-prioritize seen content for discovery)
    const seenObjectIds = seenPostIds
      .filter(id => mongoose.Types.ObjectId.isValid(id))
      .map(id => new mongoose.Types.ObjectId(id));
    if (seenObjectIds.length > 0) {
      (match.$and as unknown[]).push({ _id: { $nin: seenObjectIds } });
    }

    const cursorId = parseFeedCursor(cursor);
    if (cursorId) {
      (match.$and as unknown[]).push({ _id: { $lt: cursorId } });
    }

    return match;
  }

  /**
   * Build query for Following feed
   */
  static buildFollowingQuery(
    followingIds: string[],
    cursor?: string,
  ): Record<string, unknown> {
    const query: Record<string, unknown> = {
      oxyUserId: { $in: followingIds },
      visibility: PostVisibility.PUBLIC,
      status: 'published',
      // No parentPostId filter — replies flow through for thread slicing
      // Exclude boosts (they are shown differently)
      $and: [
        { $or: [{ boostOf: null }, { boostOf: { $exists: false } }] }
      ],
    };

    const cursorId = parseFeedCursor(cursor);
    if (cursorId) {
      query._id = { $lt: cursorId };
    }

    return query;
  }
  
  /**
   * Build query for Explore feed
   */
  static buildExploreQuery(cursor?: string): Record<string, unknown> {
    const match: Record<string, unknown> = {
      visibility: PostVisibility.PUBLIC,
      status: 'published',
      $and: [
        { $or: [{ parentPostId: null }, { parentPostId: { $exists: false } }] },
        { $or: [{ boostOf: null }, { boostOf: { $exists: false } }] }
      ]
    };

    const cursorId = parseFeedCursor(cursor);
    if (cursorId) {
      match._id = { $lt: cursorId };
    }

    return match;
  }
  
  /**
   * Build query for Media feed
   */
  static buildMediaQuery(cursor?: string): Record<string, unknown> {
    const query: Record<string, unknown> = {
      visibility: PostVisibility.PUBLIC,
      status: 'published',
      $and: [
        { $or: [
          { type: { $in: [PostType.IMAGE, PostType.VIDEO] } },
          { 'content.media.0': { $exists: true } },
          { 'content.images.0': { $exists: true } },
          { 'content.attachments.0': { $exists: true } },
          { 'content.files.0': { $exists: true } },
          { 'media.0': { $exists: true } }
        ] },
        { $or: [{ parentPostId: null }, { parentPostId: { $exists: false } }] },
        { $or: [{ boostOf: null }, { boostOf: { $exists: false } }] }
      ]
    };

    const cursorId = parseFeedCursor(cursor);
    if (cursorId) {
      query._id = { $lt: cursorId };
    }

    return query;
  }
  
  /**
   * Build query for User Profile feed
   */
  static buildUserProfileQuery(
    userId: string,
    type: FeedType = 'posts',
    cursor?: string,
  ): Record<string, unknown> {
    const query: Record<string, unknown> = {
      oxyUserId: userId,
      visibility: PostVisibility.PUBLIC,
      status: 'published',
    };

    // Filter by content type
    if (type === 'posts') {
      query.parentPostId = null;
    } else if (type === 'replies') {
      query.parentPostId = { $ne: null };
    } else if (type === 'media') {
      query.$and = [
        { $or: [
          { type: { $in: [PostType.IMAGE, PostType.VIDEO] } },
          { 'content.media.0': { $exists: true } },
          { 'content.images.0': { $exists: true } },
          { 'content.attachments.0': { $exists: true } },
          { 'content.files.0': { $exists: true } },
          { 'media.0': { $exists: true } }
        ] },
        { $or: [{ parentPostId: null }, { parentPostId: { $exists: false } }] },
        { $or: [{ boostOf: null }, { boostOf: { $exists: false } }] }
      ];
    } else if (type === 'boosts') {
      query.boostOf = { $ne: null };
    }

    // Apply a chronological keyset cursor that matches the `createdAt: -1` sort
    // used by `getUserProfileFeed`. A bare `_id < cursor` filter (the old
    // behavior) silently dropped federated posts whose `createdAt` is OLD but
    // whose import-time `_id` is LARGE than the cursor anchor — they fell on the
    // wrong side of the `_id` boundary relative to their `createdAt` position.
    // `ChronoCursor.applyToQuery` emits a compound `createdAt`/`_id` keyset for
    // `<ts>:<id>` cursors and falls back to `_id < id` for legacy bare-ObjectId
    // cursors (backward compatible with in-flight clients).
    ChronoCursor.applyToQuery(query, cursor);

    return query;
  }
}

