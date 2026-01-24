/**
 * Custom Feed Strategy
 * Handles user-created custom feeds with configurable filters
 */

import { FeedResponse } from '@mention/shared-types';
import { AuthRequest } from '../../types/auth';
import { Post } from '../../models/Post';
import CustomFeed from '../../models/CustomFeed';
import { IFeedStrategy, FeedStrategyContext, FeedStrategyOptions } from './FeedStrategy';
import { postHydrationService } from '../PostHydrationService';
import { feedRankingService } from '../FeedRankingService';
import { logger } from '../../utils/logger';
import mongoose from 'mongoose';

export class CustomFeedStrategy implements IFeedStrategy {
  private readonly FEED_FIELDS = '_id oxyUserId createdAt visibility type parentPostId repostOf quoteOf threadId content stats metadata hashtags mentions language';

  getName(): string {
    return 'custom';
  }

  async generateFeed(
    req: AuthRequest,
    options: FeedStrategyOptions,
    context: FeedStrategyContext
  ): Promise<FeedResponse> {
    const { cursor, limit, filters } = options;
    const { currentUserId } = context;

    const customFeedId = filters?.customFeedId as string;
    if (!customFeedId || !mongoose.Types.ObjectId.isValid(customFeedId)) {
      return this.emptyResponse();
    }

    // Load custom feed configuration
    const feed = await CustomFeed.findById(customFeedId).lean();
    if (!feed) {
      logger.warn('[CustomFeedStrategy] Feed not found', { customFeedId });
      return this.emptyResponse();
    }

    // Check access permissions
    if (!feed.isPublic && feed.ownerOxyUserId !== currentUserId) {
      logger.warn('[CustomFeedStrategy] Access denied', { customFeedId, currentUserId });
      return this.emptyResponse();
    }

    // Expand authors from members + source lists
    let authors: string[] = Array.from(new Set(feed.memberOxyUserIds || []));

    try {
      if (feed.sourceListIds && feed.sourceListIds.length > 0) {
        const { AccountList } = await import('../../models/AccountList');
        const lists = await AccountList.find({ _id: { $in: feed.sourceListIds } }).lean();
        for (const list of lists) {
          if (list.memberOxyUserIds) {
            authors.push(...list.memberOxyUserIds);
          }
        }
        authors = Array.from(new Set(authors));
      }
    } catch (e) {
      logger.warn('[CustomFeedStrategy] Failed to expand source lists', e);
    }

    // Exclude owner unless explicitly added as member
    const ownerId = feed.ownerOxyUserId;
    if (ownerId && !authors.includes(ownerId)) {
      authors = authors.filter(id => id !== ownerId);
    }

    // Build query
    const query = this.buildQuery(feed, authors, cursor);

    // If no query criteria, return empty
    if (!query) {
      return this.emptyResponse();
    }

    // Fetch posts
    const posts = await Post.find(query)
      .select(this.FEED_FIELDS)
      .sort({ createdAt: -1 })
      .limit(limit + 1)
      .maxTimeMS(5000)
      .lean();

    const hasMore = posts.length > limit;
    const postsToReturn = hasMore ? posts.slice(0, limit) : posts;

    // Calculate next cursor
    let nextCursor: string | undefined;
    if (postsToReturn.length > 0 && hasMore) {
      const lastPost = postsToReturn[postsToReturn.length - 1];
      nextCursor = lastPost._id.toString();

      if (cursor && nextCursor === cursor) {
        logger.warn('[CustomFeedStrategy] Cursor did not advance', { cursor, nextCursor });
        nextCursor = undefined;
      }
    }

    // Hydrate posts
    const transformedPosts = await postHydrationService.hydratePosts(postsToReturn, {
      viewerId: currentUserId,
      maxDepth: 0,
      includeLinkMetadata: true,
      includeFullArticleBody: false,
      includeFullMetadata: false,
    });

    return {
      items: transformedPosts,
      hasMore: transformedPosts.length >= limit && nextCursor !== undefined,
      nextCursor,
      totalCount: transformedPosts.length
    };
  }

  private buildQuery(feed: any, authors: string[], cursor?: string): any | null {
    const conditions: any[] = [];

    // Base visibility
    const query: any = { visibility: 'public' };

    // Author filter
    if (authors.length > 0) {
      conditions.push({ oxyUserId: { $in: authors } });
    } else if (feed.ownerOxyUserId && !authors.includes(feed.ownerOxyUserId)) {
      // Exclude owner if no authors specified
      conditions.push({ oxyUserId: { $ne: feed.ownerOxyUserId } });
    }

    // Keyword filter
    if (feed.keywords && feed.keywords.length > 0) {
      const keywordRegexes = feed.keywords.map((k: string) =>
        new RegExp(k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
      );
      conditions.push({
        $or: [
          { 'content.text': { $in: keywordRegexes } },
          { hashtags: { $in: feed.keywords.map((k: string) => k.toLowerCase()) } }
        ]
      });
    }

    // If no authors and no keywords, can't build a meaningful query
    if (authors.length === 0 && (!feed.keywords || feed.keywords.length === 0)) {
      return null;
    }

    // Content type filters
    if (feed.includeReplies === false) {
      conditions.push({ $or: [{ parentPostId: null }, { parentPostId: { $exists: false } }] });
    }

    if (feed.includeReposts === false) {
      conditions.push({ $or: [{ repostOf: null }, { repostOf: { $exists: false } }] });
    }

    if (feed.includeMedia === false) {
      conditions.push({
        $and: [
          { type: { $nin: ['image', 'video'] } },
          { 'content.media': { $exists: false } },
          { 'content.images': { $exists: false } }
        ]
      });
    }

    // Language filter
    if (feed.language) {
      conditions.push({ language: feed.language });
    }

    // Cursor pagination
    if (cursor && mongoose.Types.ObjectId.isValid(cursor)) {
      query._id = { $lt: new mongoose.Types.ObjectId(cursor) };
    }

    // Combine conditions
    if (conditions.length > 0) {
      query.$and = conditions;
    }

    return query;
  }

  private emptyResponse(): FeedResponse {
    return {
      items: [],
      hasMore: false,
      nextCursor: undefined,
      totalCount: 0
    };
  }
}
