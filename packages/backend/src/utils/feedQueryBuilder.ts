/**
 * Feed Query Builder
 * Centralized query building logic for feed endpoints
 * Separates query construction from business logic
 */

import { FeedType, PostType, PostVisibility } from '@mention/shared-types';
import mongoose from 'mongoose';
import { parseFeedCursor } from './feedUtils';

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
    const query = this.buildBaseQuery(type, filters);
    
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
  private static buildBaseQuery(type: FeedType, filters?: Record<string, unknown>): Record<string, unknown> {
    const query: Record<string, unknown> = {
      visibility: PostVisibility.PUBLIC,
      status: 'published'
    };

    // Filter by post type
    switch (type) {
      case 'posts':
        query.type = { $in: [PostType.TEXT, PostType.IMAGE, PostType.VIDEO, PostType.POLL] };
        query.parentPostId = null;
        query.repostOf = null;
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
          { $or: [{ repostOf: null }, { repostOf: { $exists: false } }] }
        ];
        break;
      }
      case 'replies':
        query.parentPostId = { $ne: null };
        break;
      case 'reposts':
        query.repostOf = { $ne: null };
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
      const oxyUserIdFilter = query.oxyUserId as any;
      if (oxyUserIdFilter && typeof oxyUserIdFilter === 'object' && '$in' in oxyUserIdFilter && Array.isArray(oxyUserIdFilter.$in)) {
        query.oxyUserId = {
          $in: oxyUserIdFilter.$in.filter((id: string) => id !== currentUserId)
        };
      } else {
        query.oxyUserId = { $ne: currentUserId };
      }
    }
    
    if (filters.includeReplies === false) {
      query.parentPostId = { $exists: false };
    }
    if (filters.includeReposts === false) {
      query.repostOf = { $exists: false };
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
      const existingCreatedAt = query.createdAt as any;
      query.createdAt = existingCreatedAt && typeof existingCreatedAt === 'object'
        ? { ...existingCreatedAt, $lte: dateTo }
        : { $lte: dateTo };
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
      _id: { $in: savedPostIds }
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
      $and: [
        { $or: [{ parentPostId: null }, { parentPostId: { $exists: false } }] },
        { $or: [{ repostOf: null }, { repostOf: { $exists: false } }] }
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
        (match.$and as any[]).push({ _id: { $nin: seenObjectIds } });
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
        (match.$and as any[]).push({ _id: { $lt: cursorId } });
      } else {
        match._id = { $lt: cursorId };
      }
    }

    return match;
  }
  
  /**
   * Build query for Following feed
   */
  static buildFollowingQuery(
    followingIds: string[],
    cursor?: string
  ): Record<string, unknown> {
    const query: Record<string, unknown> = {
      oxyUserId: { $in: followingIds },
      visibility: PostVisibility.PUBLIC,
      parentPostId: null,
      repostOf: null
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
      $and: [
        { $or: [{ parentPostId: null }, { parentPostId: { $exists: false } }] },
        { $or: [{ repostOf: null }, { repostOf: { $exists: false } }] }
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
        { $or: [{ repostOf: null }, { repostOf: { $exists: false } }] }
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
    cursor?: string
  ): Record<string, unknown> {
    const query: Record<string, unknown> = {
      oxyUserId: userId,
      visibility: PostVisibility.PUBLIC
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
        { $or: [{ repostOf: null }, { repostOf: { $exists: false } }] }
      ];
    } else if (type === 'reposts') {
      query.repostOf = { $ne: null };
    }

    const cursorId = parseFeedCursor(cursor);
    if (cursorId) {
      query._id = { $lt: cursorId };
    }

    return query;
  }
}

