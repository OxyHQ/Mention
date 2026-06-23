/**
 * Videos Feed (Reels)
 *
 * Ranked, endless stream of video posts for the fullscreen reels experience.
 * Mirrors ForYouFeed's ranking + projection so federated video posts are
 * first-class: they flow through the same candidate query, ranking pipeline,
 * thread slicing and hydration as native posts.
 *
 * Candidate criteria: public + published posts that contain at least one video
 * (post `type === 'video'` OR `content.media` contains a `{ type: 'video' }`
 * item). Multi-video posts are supported — the frontend picks the tapped video.
 *
 * Ranking blends engagement rate, recency/freshness and author affinity (via
 * FeedRankingService, same signals as ForYou). The shared author-diversity
 * rerank then spaces same-author slices and caps per-author slices per page so
 * the stream stays varied (the "connected vs unconnected" balance Instagram uses
 * for Reels chaining).
 */

import { HydratedPost, MtnConfig } from '@mention/shared-types';
import { Post } from '../../../models/Post';
import { feedRankingService } from '../../../services/FeedRankingService';
import { feedSeenPostsService } from '../../../services/FeedSeenPostsService';
import { postHydrationService } from '../../../services/PostHydrationService';
import { threadSlicingService } from '../../../services/ThreadSlicingService';
import { FeedQueryBuilder } from '../../../utils/feedQueryBuilder';
import { FeedResponseBuilder } from '../../../utils/FeedResponseBuilder';
import { FeedAPI, FeedAPIResponse, FeedFetchOptions, FeedContext, FEED_FIELDS } from '../FeedAPI';
import { ScoreCursor, didCursorAdvance } from '../CursorBuilder';
import { diversifyByAuthor } from '../diversifyByAuthor';
import {
  RankedCandidate,
  readCandidateId,
  readCandidateScore,
  sliceAuthorKey,
  sliceCursorAnchor,
} from '../rankedCandidate';
import { logger } from '../../../utils/logger';

export class VideosFeed implements FeedAPI {
  readonly descriptor = 'videos' as const;

  async peekLatest(context: FeedContext): Promise<HydratedPost | undefined> {
    const match = FeedQueryBuilder.buildVideosQuery([], undefined);
    const post = await Post.findOne(match)
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

    // De-prioritize already-seen posts so the reels stream keeps advancing.
    const seenPostIds = await feedSeenPostsService.getSeenPostIds(currentUserId);
    if (parsedCursor?.id && !seenPostIds.includes(parsedCursor.id)) {
      seenPostIds.push(parsedCursor.id);
      feedSeenPostsService.markPostsAsSeen(currentUserId, [parsedCursor.id]).catch((e) => {
        logger.warn('[VideosFeed] Failed to mark cursor post as seen', e);
      });
    }

    const match = FeedQueryBuilder.buildVideosQuery(seenPostIds, parsedCursor?.id);
    const candidateLimit = limit * MtnConfig.feed.candidateMultiplier;

    const candidatePosts = await Post.find(match)
      .select(FEED_FIELDS)
      .sort({ createdAt: -1 })
      .limit(candidateLimit)
      .maxTimeMS(5000)
      .lean();

    // Rank with the shared ranking signals (engagement, recency, affinity,
    // diversity penalty, negative signals). Decorates each post with finalScore.
    const rankedPosts = (await feedRankingService.rankPosts(candidatePosts, currentUserId, {
      followingIds: context.followingIds,
      userBehavior: context.userBehavior,
      feedSettings: context.feedSettings,
    })) as RankedCandidate[];

    // Sort by score descending with stable id tie-breaking.
    const sortedPosts = rankedPosts.sort((a, b) => {
      const diff = readCandidateScore(b) - readCandidateScore(a);
      if (Math.abs(diff) < MtnConfig.feed.scoreEpsilon) {
        return readCandidateId(b).localeCompare(readCandidateId(a));
      }
      return diff;
    });

    // Apply score-based cursor filtering (same scheme as ForYou).
    let posts = sortedPosts;
    if (parsedCursor && parsedCursor.score !== Infinity) {
      posts = sortedPosts.filter((post) => {
        const postScore = readCandidateScore(post);
        const postId = readCandidateId(post);
        if (postScore < parsedCursor.score - MtnConfig.feed.scoreEpsilon) return true;
        if (Math.abs(postScore - parsedCursor.score) < MtnConfig.feed.scoreEpsilon) {
          return postId < parsedCursor.id;
        }
        return false;
      });
    }

    // Deduplicate by id.
    const uniqueMap = new Map<string, RankedCandidate>();
    for (const post of posts) {
      const id = readCandidateId(post);
      if (id && !uniqueMap.has(id)) uniqueMap.set(id, post);
    }
    const deduped = Array.from(uniqueMap.values());

    // Thread slicing keeps multi-post video threads grouped; reply context off
    // (reels are standalone clips, not conversation threads). Runs on the FULL
    // ranked pool so a thread is one slice before author spacing; hydration
    // (expensive) runs only on the emitted page below.
    const { slices: rawSlices } = await threadSlicingService.sliceFeed(deduped, {
      enableThreadGrouping: true,
      enableReplyContext: false,
      maxSliceSize: MtnConfig.feed.maxSliceSize,
      viewerId: currentUserId,
    });

    // Shared author-diversity rerank over the WHOLE pool BEFORE truncating: a
    // prolific author's capped/over-gap excess falls PAST `limit` (other authors
    // backfill) instead of clustering at the page tail, so the reels stream stays
    // varied. Threads stay intact — a thread is one slice / one unit.
    const diversifiedSlices = diversifyByAuthor(rawSlices, sliceAuthorKey);

    const hasMore = diversifiedSlices.length > limit;
    const pageSlices = hasMore ? diversifiedSlices.slice(0, limit) : diversifiedSlices;

    const hydratedSlices = await postHydrationService.hydrateSlices(pageSlices, {
      viewerId: currentUserId,
      oxyClient: context.oxyClient,
      maxDepth: 0,
      includeLinkMetadata: true,
    });

    // Mark returned posts as seen (fire and forget).
    const allPostIds: string[] = [];
    for (const slice of hydratedSlices) {
      for (const item of slice.items) {
        const id = item.post?.id?.toString();
        if (id && id !== 'undefined' && id !== 'null') allPostIds.push(id);
      }
    }
    if (allPostIds.length > 0) {
      feedSeenPostsService.markPostsAsSeen(currentUserId, allPostIds).catch((e) => {
        logger.warn('[VideosFeed] Failed to mark posts as seen', e);
      });
    }

    // Next cursor = MINIMUM finalScore among the EMITTED page slices (the score
    // watermark). The next page filters score < this min, so no emitted slice is
    // re-shown; deferred excess scored above the cursor is intentionally dropped.
    let sliceCursor: string | undefined;
    if (pageSlices.length > 0 && hasMore) {
      let anchorScore = Infinity;
      let anchorId: string | undefined;
      for (const slice of pageSlices) {
        const anchor = sliceCursorAnchor(slice);
        if (!anchor) continue;
        if (anchor.score < anchorScore) {
          anchorScore = anchor.score;
          anchorId = anchor.id;
        }
      }
      if (anchorId && anchorScore !== Infinity) {
        sliceCursor = ScoreCursor.build(anchorScore, anchorId);
        if (!didCursorAdvance(sliceCursor, cursor)) {
          logger.warn('[VideosFeed] Cursor did not advance', { cursor, nextCursor: sliceCursor });
          sliceCursor = undefined;
        }
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

  /**
   * Anonymous fallback: most-engaged recent video posts. Uses an aggregation so
   * ranking happens in the DB (no per-user signals to apply). Federated posts
   * are included via the same `federation` projection as ForYou.
   */
  private async fetchPopular(
    cursor: string | undefined,
    limit: number,
    context: FeedContext,
  ): Promise<FeedAPIResponse> {
    const match = FeedQueryBuilder.buildVideosQuery([], cursor);
    const cfg = MtnConfig.ranking.engagement;

    const posts = await Post.aggregate([
      { $match: match },
      {
        $project: {
          _id: 1, oxyUserId: 1, federation: 1, createdAt: 1, visibility: 1, type: 1,
          parentPostId: 1, boostOf: 1, quoteOf: 1, threadId: 1,
          content: 1, stats: 1, metadata: 1, hashtags: 1, mentions: 1, language: 1,
        },
      },
      {
        $addFields: {
          engagementScore: {
            $add: [
              { $multiply: [{ $ifNull: ['$stats.likesCount', 0] }, cfg.likeWeight] },
              { $multiply: [{ $ifNull: ['$stats.boostsCount', 0] }, cfg.boostWeight] },
              { $multiply: [{ $ifNull: ['$stats.commentsCount', 0] }, cfg.commentWeight] },
            ],
          },
        },
      },
      { $sort: { engagementScore: -1, createdAt: -1, _id: -1 } },
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
      oxyClient: context.oxyClient,
      maxDepth: 0,
      includeLinkMetadata: true,
    });

    return {
      slices: [],
      items: hydrated,
      hasMore,
      nextCursor,
      totalCount: hydrated.length,
    };
  }
}
