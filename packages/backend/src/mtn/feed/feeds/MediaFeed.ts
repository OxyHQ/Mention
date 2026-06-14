/**
 * Media Feed
 *
 * Ranked, endless stream of media posts (images, videos and gifs) powering the
 * Explore "Media" tab. Mirrors VideosFeed/ForYouFeed's ranking + projection so
 * federated media posts are first-class: they flow through the same candidate
 * query, ranking pipeline, thread slicing and hydration as native posts.
 *
 * Candidate criteria: public + published posts that carry at least one media
 * attachment — a post typed as IMAGE/VIDEO, a non-empty `content.media` array,
 * or a `media` item in `content.attachments`. Posts with no media are excluded.
 *
 * Ranking blends engagement rate, recency/freshness and author affinity (via
 * FeedRankingService, same signals as ForYou). A diversity rerank then caps
 * back-to-back posts from the same author so the grid stays varied.
 */

import mongoose from 'mongoose';
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
import { logger } from '../../../utils/logger';

/**
 * Maximum number of consecutive posts allowed from the same author before the
 * diversity rerank pushes the next same-author post further down the stream.
 * A value of 1 means: never two posts from the same author back-to-back.
 */
const MAX_CONSECUTIVE_SAME_AUTHOR = 1;

/**
 * A ranked candidate post. Lean Mongo documents are decorated with `finalScore`
 * by FeedRankingService; this shape captures only the fields the feed reads
 * directly so we avoid `any` while leaving the rich post body opaque.
 */
interface RankedCandidate {
  _id: mongoose.Types.ObjectId;
  oxyUserId?: string;
  finalScore?: number;
}

function readId(post: RankedCandidate): string {
  return post._id.toString();
}

function readScore(post: RankedCandidate): number {
  return post.finalScore ?? 0;
}

/**
 * Diversity rerank: greedily reorder ranked posts so no more than
 * MAX_CONSECUTIVE_SAME_AUTHOR posts from the same author appear consecutively.
 * Preserves overall score order as closely as possible by only deferring a post
 * when its author would exceed the consecutive cap, then re-inserting it at the
 * next legal position. Stable for posts with no author conflict.
 */
function diversifyByAuthor(posts: RankedCandidate[]): RankedCandidate[] {
  if (posts.length <= 2) return posts;

  const result: RankedCandidate[] = [];
  const deferred: RankedCandidate[] = [];
  let lastAuthor: string | undefined;
  let runLength = 0;

  const pushPost = (post: RankedCandidate): void => {
    const author = post.oxyUserId;
    if (author && author === lastAuthor) {
      runLength += 1;
    } else {
      lastAuthor = author;
      runLength = 1;
    }
    result.push(post);
  };

  for (const post of posts) {
    const author = post.oxyUserId;
    const wouldExceed = Boolean(author) && author === lastAuthor && runLength >= MAX_CONSECUTIVE_SAME_AUTHOR;

    if (wouldExceed) {
      deferred.push(post);
      continue;
    }

    pushPost(post);

    // After placing a post, drain any deferred posts whose author no longer
    // conflicts with the current tail — preserves their relative score order.
    for (let i = 0; i < deferred.length; i += 1) {
      const candidate = deferred[i];
      const candidateAuthor = candidate.oxyUserId;
      const stillConflicts =
        Boolean(candidateAuthor) && candidateAuthor === lastAuthor && runLength >= MAX_CONSECUTIVE_SAME_AUTHOR;
      if (!stillConflicts) {
        deferred.splice(i, 1);
        pushPost(candidate);
        i = -1; // restart scan: placing one may unblock others
      }
    }
  }

  // Any posts still deferred (all remaining share the tail author) append in
  // score order — better to show them than to drop them from the stream.
  for (const post of deferred) {
    result.push(post);
  }

  return result;
}

export class MediaFeed implements FeedAPI {
  readonly descriptor = 'media' as const;

  async peekLatest(context: FeedContext): Promise<HydratedPost | undefined> {
    const match = FeedQueryBuilder.buildMediaFeedQuery([], undefined);
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

    // De-prioritize already-seen posts so the media stream keeps advancing.
    const seenPostIds = await feedSeenPostsService.getSeenPostIds(currentUserId);
    if (parsedCursor?.id && !seenPostIds.includes(parsedCursor.id)) {
      seenPostIds.push(parsedCursor.id);
      feedSeenPostsService.markPostsAsSeen(currentUserId, [parsedCursor.id]).catch((e) => {
        logger.warn('[MediaFeed] Failed to mark cursor post as seen', e);
      });
    }

    const match = FeedQueryBuilder.buildMediaFeedQuery(seenPostIds, parsedCursor?.id);
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
      const diff = readScore(b) - readScore(a);
      if (Math.abs(diff) < MtnConfig.feed.scoreEpsilon) {
        return readId(b).localeCompare(readId(a));
      }
      return diff;
    });

    // Apply score-based cursor filtering (same scheme as ForYou).
    let posts = sortedPosts;
    if (parsedCursor && parsedCursor.score !== Infinity) {
      posts = sortedPosts.filter((post) => {
        const postScore = readScore(post);
        const postId = readId(post);
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
      const id = readId(post);
      if (id && !uniqueMap.has(id)) uniqueMap.set(id, post);
    }
    const deduped = Array.from(uniqueMap.values());

    // Diversity rerank: no back-to-back posts from the same author.
    const diversified = diversifyByAuthor(deduped);

    const hasMore = diversified.length > limit;
    const postsToReturn = hasMore ? diversified.slice(0, limit) : diversified;

    // Build next cursor from the last returned post's score.
    let nextCursor: string | undefined;
    if (postsToReturn.length > 0 && hasMore) {
      const last = postsToReturn[postsToReturn.length - 1];
      nextCursor = ScoreCursor.build(readScore(last), readId(last));
      if (!didCursorAdvance(nextCursor, cursor)) {
        logger.warn('[MediaFeed] Cursor did not advance', { cursor, nextCursor });
        nextCursor = undefined;
      }
    }

    // Thread slicing keeps multi-post media threads grouped; reply context off
    // (media posts are standalone, not conversation threads).
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
        logger.warn('[MediaFeed] Failed to mark posts as seen', e);
      });
    }

    // Recompute the cursor from the last slice's anchor so pagination lines up
    // with what was actually returned after slicing.
    let sliceCursor: string | undefined;
    if (hydratedSlices.length > 0 && hasMore) {
      const lastSlice = hydratedSlices[hydratedSlices.length - 1];
      const anchorPost = lastSlice.items[0]?.post;
      const rawAnchor = postsToReturn.find((p) => readId(p) === anchorPost?.id);
      if (rawAnchor) {
        sliceCursor = ScoreCursor.build(readScore(rawAnchor), readId(rawAnchor));
      }
    }

    return FeedResponseBuilder.buildSlicedResponse({
      slices: hydratedSlices,
      limit,
      previousCursor: cursor,
      cursorFromLastSlice: sliceCursor ?? nextCursor,
      hasMore,
    });
  }

  /**
   * Anonymous fallback: most-engaged recent media posts. Uses an aggregation so
   * ranking happens in the DB (no per-user signals to apply). Federated posts
   * are included via the same `federation` projection as ForYou.
   */
  private async fetchPopular(
    cursor: string | undefined,
    limit: number,
    context: FeedContext,
  ): Promise<FeedAPIResponse> {
    const match = FeedQueryBuilder.buildMediaFeedQuery([], cursor);
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
