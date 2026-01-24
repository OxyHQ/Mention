/**
 * Following Feed Strategy
 * Shows posts from users that the current user follows, sorted chronologically
 */

import { FeedResponse } from '@mention/shared-types';
import { AuthRequest } from '../../types/auth';
import { Post } from '../../models/Post';
import { IFeedStrategy, FeedStrategyContext, FeedStrategyOptions } from './FeedStrategy';
import { postHydrationService } from '../PostHydrationService';
import { logger } from '../../utils/logger';
import mongoose from 'mongoose';

export class FollowingFeedStrategy implements IFeedStrategy {
  private readonly FEED_FIELDS = '_id oxyUserId createdAt visibility type parentPostId repostOf quoteOf threadId content stats metadata hashtags mentions language';

  getName(): string {
    return 'following';
  }

  async generateFeed(
    req: AuthRequest,
    options: FeedStrategyOptions,
    context: FeedStrategyContext
  ): Promise<FeedResponse> {
    const { cursor, limit } = options;
    const { currentUserId, followingIds } = context;

    // Must be authenticated and have following list
    if (!currentUserId) {
      return {
        items: [],
        hasMore: false,
        nextCursor: undefined,
        totalCount: 0
      };
    }

    // If user doesn't follow anyone, return empty feed
    if (!followingIds || followingIds.length === 0) {
      return {
        items: [],
        hasMore: false,
        nextCursor: undefined,
        totalCount: 0
      };
    }

    // Build query for posts from followed users
    const match: any = {
      oxyUserId: { $in: followingIds },
      visibility: { $in: ['public', 'followers'] },
      // Exclude replies (they should appear in threads, not in main feed)
      $or: [
        { parentPostId: null },
        { parentPostId: { $exists: false } }
      ]
    };

    // Add cursor-based pagination
    if (cursor && mongoose.Types.ObjectId.isValid(cursor)) {
      match._id = { $lt: new mongoose.Types.ObjectId(cursor) };
    }

    // Fetch posts
    const posts = await Post.find(match)
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

      // Validate cursor advanced
      if (cursor && nextCursor === cursor) {
        logger.warn('[FollowingFeed] Cursor did not advance, stopping pagination', { cursor, nextCursor });
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
}
