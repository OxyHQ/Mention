/**
 * Explore Feed
 *
 * Trending/discovery content from users not yet followed.
 * Replaces ExploreFeedStrategy.
 */

import { HydratedPost } from '@mention/shared-types';
import { MtnConfig } from '@mention/shared-types';
import { Post } from '../../../models/Post';
import { postHydrationService } from '../../../services/PostHydrationService';
import { threadSlicingService } from '../../../services/ThreadSlicingService';
import { FeedResponseBuilder } from '../../../utils/FeedResponseBuilder';
import { FeedAPI, FeedAPIResponse, FeedFetchOptions, FeedContext, FEED_FIELDS } from '../FeedAPI';
import { ScoreCursor, didCursorAdvance } from '../CursorBuilder';
import { logger } from '../../../utils/logger';
import mongoose from 'mongoose';

export class ExploreFeed implements FeedAPI {
  readonly descriptor = 'explore' as const;

  async peekLatest(context: FeedContext): Promise<HydratedPost | undefined> {
    const trendingCutoff = new Date(Date.now() - MtnConfig.feed.trendingWindowMs);
    const post = await Post.findOne({
      visibility: 'public',
      createdAt: { $gte: trendingCutoff } as any,
      $and: [
        { $or: [{ parentPostId: null }, { parentPostId: { $exists: false } }] },
        { $or: [{ repostOf: null }, { repostOf: { $exists: false } }] },
      ],
    })
      .select(FEED_FIELDS)
      .sort({ createdAt: -1 })
      .lean();

    if (!post) return undefined;
    const [hydrated] = await postHydrationService.hydratePosts([post], {
      viewerId: context.currentUserId,
      maxDepth: 0,
    });
    return hydrated;
  }

  async fetch(options: FeedFetchOptions, context: FeedContext): Promise<FeedAPIResponse> {
    const { cursor, limit } = options;
    const { currentUserId, followingIds } = context;

    // Exclude followed users for discovery
    const excludeUserIds: string[] = [];
    if (currentUserId) excludeUserIds.push(currentUserId);
    if (followingIds?.length) excludeUserIds.push(...followingIds);

    const trendingCutoff = new Date(Date.now() - MtnConfig.feed.trendingWindowMs);

    const match: any = {
      visibility: 'public',
      status: 'published',
      createdAt: { $gte: trendingCutoff },
      $and: [
        { $or: [{ parentPostId: null }, { parentPostId: { $exists: false } }] },
        { $or: [{ repostOf: null }, { repostOf: { $exists: false } }] },
      ],
    };

    if (excludeUserIds.length > 0) {
      match.oxyUserId = { $nin: excludeUserIds };
    }

    // Parse score cursor
    let cursorScore: number | undefined;
    let cursorId: string | undefined;
    if (cursor) {
      const parsed = ScoreCursor.parse(cursor);
      if (parsed && parsed.score !== Infinity) {
        cursorScore = parsed.score;
        cursorId = parsed.id;
      }
    }

    const cfg = MtnConfig.ranking.engagement;

    const pipeline: any[] = [
      { $match: match },
      {
        $project: {
          _id: 1, oxyUserId: 1, federation: 1, createdAt: 1, visibility: 1, type: 1,
          parentPostId: 1, repostOf: 1, quoteOf: 1, threadId: 1,
          content: 1, stats: 1, metadata: 1, hashtags: 1, mentions: 1, language: 1,
        },
      },
      {
        $addFields: {
          engagementScore: {
            $add: [
              { $multiply: [{ $ifNull: ['$stats.likesCount', 0] }, cfg.likeWeight] },
              { $multiply: [{ $ifNull: ['$stats.repostsCount', 0] }, cfg.repostWeight] },
              { $multiply: [{ $ifNull: ['$stats.commentsCount', 0] }, cfg.commentWeight] },
            ],
          },
          recencyBoost: {
            $divide: [{ $subtract: ['$createdAt', trendingCutoff] }, MtnConfig.feed.trendingWindowMs],
          },
        },
      },
      {
        $addFields: {
          finalScore: { $add: ['$engagementScore', { $multiply: ['$recencyBoost', 10] }] },
        },
      },
    ];

    // Cursor filter
    if (cursorScore !== undefined && cursorId) {
      pipeline.push({
        $match: {
          $or: [
            { finalScore: { $lt: cursorScore } },
            {
              $and: [
                { finalScore: cursorScore },
                { _id: { $lt: new mongoose.Types.ObjectId(cursorId) } },
              ],
            },
          ],
        },
      });
    }

    pipeline.push({ $sort: { finalScore: -1, _id: -1 } }, { $limit: limit + 1 });

    const posts = await Post.aggregate(pipeline).option({ maxTimeMS: 5000 });

    const hasMore = posts.length > limit;
    const postsToReturn = hasMore ? posts.slice(0, limit) : posts;

    // Build cursor
    let nextCursor: string | undefined;
    if (postsToReturn.length > 0 && hasMore) {
      const last = postsToReturn[postsToReturn.length - 1];
      nextCursor = ScoreCursor.build(last.finalScore ?? 0, last._id.toString());
      if (!didCursorAdvance(nextCursor, cursor)) {
        logger.warn('[ExploreFeed] Cursor did not advance', { cursor, nextCursor });
        nextCursor = undefined;
      }
    }

    // Thread slicing (self-thread grouping only for explore)
    const { slices: rawSlices } = await threadSlicingService.sliceFeed(postsToReturn, {
      enableThreadGrouping: true,
      enableReplyContext: false,
      maxSliceSize: MtnConfig.feed.maxSliceSize,
      viewerId: currentUserId,
    });

    const hydratedSlices = await postHydrationService.hydrateSlices(rawSlices, {
      viewerId: currentUserId,
      oxyClient: context.oxyClient,
      maxDepth: 0,
      includeLinkMetadata: true,
    });

    return FeedResponseBuilder.buildSlicedResponse({
      slices: hydratedSlices,
      limit,
      previousCursor: cursor,
      cursorFromLastSlice: nextCursor,
      hasMore,
    });
  }
}
