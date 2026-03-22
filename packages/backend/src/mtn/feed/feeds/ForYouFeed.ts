/**
 * For You Feed
 *
 * Personalized ranked feed. Falls back to popular posts for unauthenticated users.
 * Replaces ForYouFeedStrategy.
 */

import { FeedResponse, HydratedPost } from '@mention/shared-types';
import { MtnConfig } from '@mention/shared-types';
import { Post } from '../../../models/Post';
import { feedRankingService } from '../../../services/FeedRankingService';
import { feedSeenPostsService } from '../../../services/FeedSeenPostsService';
import { postHydrationService } from '../../../services/PostHydrationService';
import { threadSlicingService } from '../../../services/ThreadSlicingService';
import { FeedQueryBuilder } from '../../../utils/feedQueryBuilder';
import { FeedResponseBuilder } from '../../../utils/FeedResponseBuilder';
import { FeedAPI, FeedAPIResponse, FeedFetchOptions, FeedContext, FEED_FIELDS } from '../FeedAPI';
import { ScoreCursor, didCursorAdvance } from '../CursorBuilder';
import { logger } from '../../../utils/logger';
import mongoose from 'mongoose';

export class ForYouFeed implements FeedAPI {
  readonly descriptor = 'for_you' as const;

  async peekLatest(context: FeedContext): Promise<HydratedPost | undefined> {
    const post = await Post.findOne({
      visibility: 'public',
      $and: [{ $or: [{ repostOf: null }, { repostOf: { $exists: false } }] }],
    })
      .select(FEED_FIELDS)
      .sort({ createdAt: -1 })
      .lean();

    if (!post) return undefined;
    const [hydrated] = await postHydrationService.hydratePosts([post], {
      viewerId: context.currentUserId,
      oxyClient: context.oxyClient,
      maxDepth: 0,
    });
    return hydrated;
  }

  async fetch(options: FeedFetchOptions, context: FeedContext): Promise<FeedAPIResponse> {
    const { cursor, limit } = options;
    const { currentUserId } = context;

    if (!currentUserId) {
      return this.fetchPopular(cursor, limit, context);
    }

    const parsedCursor = ScoreCursor.parse(cursor);

    // Get seen post IDs
    const seenPostIds = await feedSeenPostsService.getSeenPostIds(currentUserId);
    if (parsedCursor?.id && !seenPostIds.includes(parsedCursor.id)) {
      seenPostIds.push(parsedCursor.id);
      feedSeenPostsService.markPostsAsSeen(currentUserId, [parsedCursor.id]).catch((e) => {
        logger.warn('Failed to mark cursor post as seen', e);
      });
    }

    const match = FeedQueryBuilder.buildForYouQuery(seenPostIds, parsedCursor?.id);
    const candidateLimit = limit * MtnConfig.feed.candidateMultiplier;

    const candidatePosts = await Post.find(match)
      .select(FEED_FIELDS)
      .sort({ createdAt: -1 })
      .limit(candidateLimit)
      .maxTimeMS(5000)
      .lean();

    // Rank posts
    const rankedPosts = await feedRankingService.rankPosts(candidatePosts, currentUserId, {
      followingIds: context.followingIds,
      userBehavior: context.userBehavior,
      feedSettings: context.feedSettings,
    });

    // Sort by score descending
    const sortedPosts = rankedPosts.sort((a, b) => {
      const scoreA = (a as any).finalScore ?? 0;
      const scoreB = (b as any).finalScore ?? 0;
      const diff = scoreB - scoreA;
      if (Math.abs(diff) < MtnConfig.feed.scoreEpsilon) {
        return b._id.toString().localeCompare(a._id.toString());
      }
      return diff;
    });

    // Apply score-based cursor filtering
    let posts = sortedPosts;
    if (parsedCursor && parsedCursor.score !== Infinity) {
      posts = sortedPosts.filter((post) => {
        const postScore = (post as any).finalScore ?? 0;
        const postId = post._id.toString();
        if (postScore < parsedCursor.score - MtnConfig.feed.scoreEpsilon) return true;
        if (Math.abs(postScore - parsedCursor.score) < MtnConfig.feed.scoreEpsilon) {
          return postId < parsedCursor.id;
        }
        return false;
      });
    }

    // Deduplicate
    const uniqueMap = new Map<string, any>();
    for (const post of posts) {
      const id = post._id?.toString() || '';
      if (id && !uniqueMap.has(id)) uniqueMap.set(id, post);
    }
    const deduped = Array.from(uniqueMap.values());

    const hasMore = deduped.length > limit;
    const postsToReturn = hasMore ? deduped.slice(0, limit) : deduped;

    // Build next cursor
    let nextCursor: string | undefined;
    if (postsToReturn.length > 0 && hasMore) {
      const last = postsToReturn[postsToReturn.length - 1];
      nextCursor = ScoreCursor.build((last as any).finalScore ?? 0, last._id.toString());
      if (!didCursorAdvance(nextCursor, cursor)) {
        logger.warn('[ForYouFeed] Cursor did not advance', { cursor, nextCursor });
        nextCursor = undefined;
      }
    }

    // Thread slicing
    const { slices: rawSlices } = await threadSlicingService.sliceFeed(postsToReturn, {
      enableThreadGrouping: true,
      enableReplyContext: true,
      maxSliceSize: MtnConfig.feed.maxSliceSize,
      viewerId: currentUserId,
    });

    const hydratedSlices = await postHydrationService.hydrateSlices(rawSlices, {
      viewerId: currentUserId,
      oxyClient: context.oxyClient,
      maxDepth: 0,
      includeLinkMetadata: true,
    });

    // Mark posts as seen (fire and forget)
    const allPostIds: string[] = [];
    for (const slice of hydratedSlices) {
      for (const item of slice.items) {
        const id = item.post?.id?.toString();
        if (id && id !== 'undefined' && id !== 'null') allPostIds.push(id);
      }
    }
    if (allPostIds.length > 0) {
      feedSeenPostsService.markPostsAsSeen(currentUserId, allPostIds).catch((e) => {
        logger.warn('Failed to mark posts as seen', e);
      });
    }

    // Recalculate cursor from last slice's anchor
    let sliceCursor: string | undefined;
    if (hydratedSlices.length > 0 && hasMore) {
      const lastSlice = hydratedSlices[hydratedSlices.length - 1];
      const anchorPost = lastSlice.items[0]?.post;
      const rawAnchor = postsToReturn.find((p) => p._id?.toString() === anchorPost?.id);
      if (rawAnchor) {
        sliceCursor = ScoreCursor.build((rawAnchor as any).finalScore ?? 0, rawAnchor._id.toString());
      }
    }

    return FeedResponseBuilder.buildSlicedResponse({
      slices: hydratedSlices,
      limit,
      previousCursor: cursor,
      cursorFromLastSlice: sliceCursor,
      hasMore,
    });
  }

  private async fetchPopular(cursor: string | undefined, limit: number, context: FeedContext): Promise<FeedAPIResponse> {
    const match: any = {
      visibility: 'public',
      $and: [{ $or: [{ repostOf: null }, { repostOf: { $exists: false } }] }],
    };

    if (cursor && mongoose.Types.ObjectId.isValid(cursor)) {
      match._id = { $lt: new mongoose.Types.ObjectId(cursor) };
    }

    const cfg = MtnConfig.ranking.engagement;
    const posts = await Post.aggregate([
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
        },
      },
      { $sort: { engagementScore: -1, createdAt: -1 } },
      { $limit: limit + 1 },
    ]).option({ maxTimeMS: 5000 });

    const hasMore = posts.length > limit;
    const postsToReturn = hasMore ? posts.slice(0, limit) : posts;
    const nextCursor =
      hasMore && postsToReturn.length > 0
        ? postsToReturn[postsToReturn.length - 1]._id.toString()
        : undefined;

    const hydrated = await postHydrationService.hydratePosts(postsToReturn, {
      viewerId: undefined,
      maxDepth: 0,
      includeLinkMetadata: true,
    });

    // Return as sliced response for consistency
    return {
      slices: [],
      items: hydrated,
      hasMore,
      cursor: nextCursor,
      totalCount: hydrated.length,
    };
  }
}
