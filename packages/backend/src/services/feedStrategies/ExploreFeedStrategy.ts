/**
 * Explore Feed Strategy
 * Shows trending/popular content for discovery - posts from users the current user doesn't follow
 */

import { FeedResponse } from '@mention/shared-types';
import { AuthRequest } from '../../types/auth';
import { Post } from '../../models/Post';
import { IFeedStrategy, FeedStrategyContext, FeedStrategyOptions } from './FeedStrategy';
import { postHydrationService } from '../PostHydrationService';
import { logger } from '../../utils/logger';
import mongoose from 'mongoose';

export class ExploreFeedStrategy implements IFeedStrategy {
  private readonly FEED_FIELDS = '_id oxyUserId createdAt visibility type parentPostId repostOf quoteOf threadId content stats metadata hashtags mentions language';
  // Time window for trending (24 hours)
  private readonly TRENDING_WINDOW_MS = 24 * 60 * 60 * 1000;

  getName(): string {
    return 'explore';
  }

  async generateFeed(
    req: AuthRequest,
    options: FeedStrategyOptions,
    context: FeedStrategyContext
  ): Promise<FeedResponse> {
    const { cursor, limit } = options;
    const { currentUserId, followingIds } = context;

    // Build exclusion list (users the current user follows + self)
    const excludeUserIds: string[] = [];
    if (currentUserId) {
      excludeUserIds.push(currentUserId);
    }
    if (followingIds && followingIds.length > 0) {
      excludeUserIds.push(...followingIds);
    }

    // Time window for trending posts
    const trendingCutoff = new Date(Date.now() - this.TRENDING_WINDOW_MS);

    // Build match query
    const match: any = {
      visibility: 'public',
      createdAt: { $gte: trendingCutoff },
      // Exclude replies
      $and: [
        { $or: [{ parentPostId: null }, { parentPostId: { $exists: false } }] },
        { $or: [{ repostOf: null }, { repostOf: { $exists: false } }] }
      ]
    };

    // Exclude posts from followed users (for discovery)
    if (excludeUserIds.length > 0) {
      match.oxyUserId = { $nin: excludeUserIds };
    }

    // Add cursor-based pagination using engagement score threshold
    let cursorScore: number | undefined;
    let cursorId: string | undefined;
    if (cursor) {
      // Cursor format: "score:id" for stable pagination on ranked content
      const [scoreStr, id] = cursor.split(':');
      cursorScore = parseFloat(scoreStr);
      cursorId = id;
    }

    // Use aggregation for ranking by engagement
    const pipeline: any[] = [
      { $match: match },
      {
        $project: {
          _id: 1,
          oxyUserId: 1,
          createdAt: 1,
          visibility: 1,
          type: 1,
          parentPostId: 1,
          repostOf: 1,
          quoteOf: 1,
          threadId: 1,
          content: 1,
          stats: 1,
          metadata: 1,
          hashtags: 1,
          mentions: 1,
          language: 1
        }
      },
      {
        $addFields: {
          // Engagement score: likes + 2*reposts + 1.5*comments
          engagementScore: {
            $add: [
              { $ifNull: ['$stats.likesCount', 0] },
              { $multiply: [{ $ifNull: ['$stats.repostsCount', 0] }, 2] },
              { $multiply: [{ $ifNull: ['$stats.commentsCount', 0] }, 1.5] }
            ]
          },
          // Recency boost (newer posts get slight boost)
          recencyBoost: {
            $divide: [
              { $subtract: ['$createdAt', trendingCutoff] },
              this.TRENDING_WINDOW_MS
            ]
          }
        }
      },
      {
        $addFields: {
          // Final score combines engagement with recency
          finalScore: {
            $add: [
              '$engagementScore',
              { $multiply: ['$recencyBoost', 10] } // Slight recency boost
            ]
          }
        }
      }
    ];

    // Add cursor filter if paginating
    if (cursorScore !== undefined && cursorId) {
      pipeline.push({
        $match: {
          $or: [
            { finalScore: { $lt: cursorScore } },
            {
              $and: [
                { finalScore: cursorScore },
                { _id: { $lt: new mongoose.Types.ObjectId(cursorId) } }
              ]
            }
          ]
        }
      });
    }

    // Sort and limit
    pipeline.push(
      { $sort: { finalScore: -1, _id: -1 } },
      { $limit: limit + 1 }
    );

    const posts = await Post.aggregate(pipeline).option({ maxTimeMS: 5000 });

    const hasMore = posts.length > limit;
    const postsToReturn = hasMore ? posts.slice(0, limit) : posts;

    // Calculate next cursor using score:id format for stable pagination
    let nextCursor: string | undefined;
    if (postsToReturn.length > 0 && hasMore) {
      const lastPost = postsToReturn[postsToReturn.length - 1];
      const lastScore = lastPost.finalScore ?? 0;
      nextCursor = `${lastScore}:${lastPost._id.toString()}`;

      // Validate cursor advanced
      if (cursor && nextCursor === cursor) {
        logger.warn('[ExploreFeed] Cursor did not advance, stopping pagination', { cursor, nextCursor });
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
