/**
 * Feed Query Builder
 * Centralized query building logic for feed endpoints
 * Separates query construction from business logic
 */

import { FeedType, PostType, PostVisibility, MtnConfig } from '@mention/shared-types';
import mongoose from 'mongoose';
import { ContentLabel } from '../models/ContentLabel';
import { parseFeedCursor } from './feedUtils';

export interface FeedQueryOptions {
  type: FeedType;
  filters?: Record<string, unknown>;
  currentUserId?: string;
  cursor?: string;
  limit?: number;
  savedPostIds?: mongoose.Types.ObjectId[];
}

export interface VideosQueryOptions {
  /** Minimum video duration in seconds (defaults to {@link MtnConfig.videosFeed.minDurationSec}). */
  minDurationSec?: number;
  /**
   * Restrict to videos with this stored orientation.
   * Omit to use {@link MtnConfig.videosFeed.defaultOrientation} (`portrait`).
   * Pass `'all'` to include every orientation with persisted metadata.
   */
  orientation?: 'portrait' | 'landscape' | 'square' | 'all';
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
      // Match the canonical multi-language array (multikey index): Mongo matches an
      // array field by element equality, so the scalar matches any post whose
      // `postClassification.languages` contains it.
      query['postClassification.languages'] = filters.language;
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
          { 'content.variants.text': { $in: regexes } },
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
        query['content.variants.text'] = {
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
   * Matches public, published posts whose `content.media[]` contains a video
   * item with persisted metadata: durationSec ≥ min (default 20), orientation,
   * width, and height. Both native and federated posts are included (no
   * federation exclusion). Boosts are excluded (the underlying original is
   * surfaced instead). Replies flow through so multi-post threads can still
   * be sliced.
   *
   * CONTENT PREDICATE + SEEN SET ONLY — deliberately NO cursor. Every consumer
   * feeds a RANKED pipeline (`videosSource`, `popularVideosSource`) whose page
   * order is a score, not `_id`, so a cursor bound here would drop candidates on
   * an axis nothing sorts by. Each consumer applies its own keyset on the axis it
   * actually orders by; see the note above {@link videosSource}.
   */
  static buildVideosQuery(
    seenPostIds: string[],
    options: VideosQueryOptions = {},
  ): Record<string, unknown> {
    const minDurationSec = options.minDurationSec ?? MtnConfig.videosFeed.minDurationSec;
    const orientation = options.orientation ?? MtnConfig.videosFeed.defaultOrientation;
    // UNKNOWN IS NOT A VALUE. Both of these used to treat a missing field as a
    // failed match, which silently made the videos feed mean "the videos whose
    // metadata we happen to have" rather than what it says.
    //
    // Measured against production (2026-07-30): of 9,465 posts carrying a video
    // media item, `durationSec` is present on 5.9% — and on 0% of the last day's
    // arrivals. Federated video is the ENTIRE video corpus (native video posts:
    // 0), and Mastodon advertises width/height but essentially never duration.
    // So a `$gte` on a mostly-absent field was not enforcing a 20-second policy
    // on the corpus; it was discarding 94% of it and enforcing the policy on the
    // remainder. The shipped default pool was 147 posts out of 9,465.
    //
    // NOT because the data is unobtainable: 7,489 of those posts (79%) are
    // mirrored into Oxy and DO carry an Oxy file id, and Oxy already probed them
    // — 96.4% of oxy-prod's video files hold `metadata.media.durationSec`.
    // `enrichFromOxy` reads exactly that, so it is the fix, not a dead end; it
    // simply was never reaching these posts (see `mediaMetadataEnrichJob`).
    //
    // Duration therefore applies WHEN KNOWN and abstains when absent. The
    // editorial intent (prefer substantial videos) is preserved exactly for every
    // post we can actually judge. The real fix is upstream — collect the
    // metadata Oxy already has — and this does not substitute for it: 5,576
    // posts have no dimensions either, and no filter relaxation reaches those.
    const elemMatch: Record<string, unknown> = {
      type: 'video',
      $or: [
        { durationSec: { $gte: minDurationSec } },
        { durationSec: { $exists: false } },
      ],
      width: { $gt: 0 },
      height: { $gt: 0 },
    };

    // `'all'` is the one setting whose NAME promises no filtering, so it must not
    // compile to a filter. It costs ~0 posts today only because `width`/`height`
    // already imply orientation was derivable, but it becomes load-bearing the
    // moment that dimension gate is relaxed.
    if (orientation !== 'all') {
      elemMatch.orientation = orientation;
    }

    const strictMediaMatch = {
      'content.media': { $elemMatch: elemMatch },
    };

    const match: Record<string, unknown> = {
      visibility: PostVisibility.PUBLIC,
      status: 'published',
      $and: [
        strictMediaMatch,
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
   *
   * CONTENT PREDICATE + SEEN SET ONLY — deliberately NO cursor, for the reason
   * given on {@link FeedQueryBuilder.buildVideosQuery}.
   */
  static buildMediaFeedQuery(seenPostIds: string[]): Record<string, unknown> {
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
  
}

