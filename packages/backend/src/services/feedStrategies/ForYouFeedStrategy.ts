/**
 * For You Feed Strategy
 * Personalized feed with ranking algorithm
 */

import { FeedResponse } from '@mention/shared-types';
import { AuthRequest } from '../../types/auth';
import { Post } from '../../models/Post';
import { feedRankingService } from '../FeedRankingService';
import { feedSeenPostsService } from '../FeedSeenPostsService';
import { FeedQueryBuilder } from '../../utils/feedQueryBuilder';
import { IFeedStrategy, FeedStrategyContext, FeedStrategyOptions } from './FeedStrategy';
import { postHydrationService } from '../PostHydrationService';
import { logger } from '../../utils/logger';
import mongoose from 'mongoose';

export class ForYouFeedStrategy implements IFeedStrategy {
  private readonly FEED_FIELDS = '_id oxyUserId createdAt visibility type parentPostId repostOf quoteOf threadId content stats metadata hashtags mentions language';
  private readonly RANKED_FEED_CANDIDATE_MULTIPLIER = 2;
  private readonly SCORE_EPSILON = 0.001;

  getName(): string {
    return 'for_you';
  }

  async generateFeed(
    req: AuthRequest,
    options: FeedStrategyOptions,
    context: FeedStrategyContext
  ): Promise<FeedResponse> {
    const { cursor, limit } = options;
    const { currentUserId } = context;

    // For unauthenticated users, return popular posts
    if (!currentUserId) {
      return this.generatePopularFeed(cursor, limit);
    }

    // Get seen post IDs
    const seenPostIds = await feedSeenPostsService.getSeenPostIds(currentUserId);

    // Add cursor to seen posts
    if (cursor && mongoose.Types.ObjectId.isValid(cursor)) {
      if (!seenPostIds.includes(cursor)) {
        seenPostIds.push(cursor);
        feedSeenPostsService.markPostsAsSeen(currentUserId, [cursor])
          .catch(error => {
            logger.warn('Failed to mark cursor post as seen (non-critical)', error);
          });
      }
    }

    // Build query
    const match = FeedQueryBuilder.buildForYouQuery(seenPostIds, cursor);

    // Get candidate posts (fetch more than needed for ranking)
    const candidateLimit = limit * this.RANKED_FEED_CANDIDATE_MULTIPLIER;
    const candidatePosts = await Post.find(match)
      .select(this.FEED_FIELDS)
      .sort({ createdAt: -1 })
      .limit(candidateLimit)
      .maxTimeMS(5000)
      .lean();

    // Rank posts
    const rankedPosts = await feedRankingService.rankPosts(
      candidatePosts,
      currentUserId,
      {
        followingIds: context.followingIds,
        userBehavior: context.userBehavior,
        feedSettings: context.feedSettings
      }
    );

    // Sort by score
    const posts = rankedPosts.sort((a, b) => {
      const scoreA = (a as any).finalScore ?? 0;
      const scoreB = (b as any).finalScore ?? 0;
      const scoreDiff = scoreB - scoreA;
      
      if (Math.abs(scoreDiff) < this.SCORE_EPSILON) {
        return a._id.toString().localeCompare(b._id.toString()) * -1;
      }
      return scoreDiff;
    });

    // Deduplicate
    const uniquePostsMap = new Map<string, any>();
    for (const post of posts) {
      const rawId = post._id?.toString() || '';
      if (rawId && !uniquePostsMap.has(rawId)) {
        uniquePostsMap.set(rawId, post);
      }
    }
    const deduplicatedPosts = Array.from(uniquePostsMap.values());

    const hasMore = deduplicatedPosts.length > limit;
    const postsToReturn = hasMore ? deduplicatedPosts.slice(0, limit) : deduplicatedPosts;
    
    // Calculate cursor
    let nextCursor: string | undefined;
    if (postsToReturn.length > 0 && hasMore) {
      const lastPost = postsToReturn[postsToReturn.length - 1];
      nextCursor = lastPost._id.toString();
      
      if (cursor && nextCursor === cursor) {
        logger.warn('⚠️ Cursor did not advance, stopping pagination', { cursor, nextCursor });
        nextCursor = undefined;
      }
    }

    // Transform posts
    const transformedPosts = await postHydrationService.hydratePosts(postsToReturn, {
      viewerId: currentUserId,
      maxDepth: 0,
      includeLinkMetadata: true,
      includeFullArticleBody: false,
      includeFullMetadata: false,
    });

    // Mark posts as seen
    if (transformedPosts.length > 0) {
      const postIdsToMark = transformedPosts
        .map(post => post.id?.toString())
        .filter((id): id is string => !!id && id !== 'undefined' && id !== 'null');
      
      if (postIdsToMark.length > 0) {
        feedSeenPostsService.markPostsAsSeen(currentUserId, postIdsToMark)
          .catch(error => {
            logger.warn('Failed to mark posts as seen (non-critical)', error);
          });
      }
    }

    return {
      items: transformedPosts,
      hasMore: transformedPosts.length >= limit && nextCursor !== undefined,
      nextCursor,
      totalCount: transformedPosts.length
    };
  }

  private async generatePopularFeed(cursor?: string, limit: number = 20): Promise<FeedResponse> {
    const match: any = {
      visibility: 'public',
      $and: [
        { $or: [{ parentPostId: null }, { parentPostId: { $exists: false } }] },
        { $or: [{ repostOf: null }, { repostOf: { $exists: false } }] }
      ]
    };

    if (cursor && mongoose.Types.ObjectId.isValid(cursor)) {
      match._id = { $lt: new mongoose.Types.ObjectId(cursor) };
    }

    const posts = await Post.aggregate([
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
          engagementScore: {
            $add: [
              { $ifNull: ['$stats.likesCount', 0] },
              { $multiply: [{ $ifNull: ['$stats.repostsCount', 0] }, 2] },
              { $multiply: [{ $ifNull: ['$stats.commentsCount', 0] }, 1.5] }
            ]
          }
        }
      },
      { $sort: { engagementScore: -1, createdAt: -1 } },
      { $limit: limit + 1 }
    ]).option({ maxTimeMS: 5000 });

    const hasMore = posts.length > limit;
    const postsToReturn = hasMore ? posts.slice(0, limit) : posts;
    const nextCursor = hasMore && postsToReturn.length > 0 
      ? postsToReturn[postsToReturn.length - 1]._id.toString() 
      : undefined;

    const transformedPosts = await postHydrationService.hydratePosts(postsToReturn, {
      viewerId: undefined,
      maxDepth: 0,
      includeLinkMetadata: true,
      includeFullArticleBody: false,
      includeFullMetadata: false,
    });

    return {
      items: transformedPosts,
      hasMore,
      nextCursor,
      totalCount: transformedPosts.length
    };
  }
}

