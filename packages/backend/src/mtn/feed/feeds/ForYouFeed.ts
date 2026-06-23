/**
 * For You Feed
 *
 * Personalized ranked feed. Falls back to popular posts for unauthenticated users.
 * Replaces ForYouFeedStrategy.
 */

import { HydratedPost } from '@mention/shared-types';
import { MtnConfig } from '@mention/shared-types';
import { Post } from '../../../models/Post';
import { feedRankingService } from '../../../services/FeedRankingService';
import { feedSeenPostsService } from '../../../services/FeedSeenPostsService';
import { postHydrationService } from '../../../services/PostHydrationService';
import { threadSlicingService } from '../../../services/ThreadSlicingService';
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
import { gatherForYouCandidates, CandidateUserBehavior } from './forYouCandidateSources';
import mongoose from 'mongoose';

export class ForYouFeed implements FeedAPI {
  readonly descriptor = 'for_you' as const;

  async peekLatest(context: FeedContext): Promise<HydratedPost | undefined> {
    const post = await Post.findOne({
      visibility: 'public',
      $and: [{ $or: [{ boostOf: null }, { boostOf: { $exists: false } }] }],
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

    // MULTI-SOURCE candidate generation. Instead of ranking only the global
    // newest-N public posts (so ranking never saw relevant followed / affinity /
    // preferred-topic content unless it landed in the global-recency window), we
    // gather a bounded UNION of personalized sources — following, affinity,
    // preferred topics/language/region, trending, and a small global-discovery
    // tail — and feed that pool into the SAME ranking pipeline below.
    //
    // Forward progress across pages comes from the score cursor + the
    // seen-posts exclusion (the cursor's id is added to `seenPostIds` above and
    // every source excludes seen ids), so the pool is gathered by recency within
    // the window and the score-descending cursor handles pagination — no
    // per-source `_id < cursor` narrowing (that would drop recent low-scoring
    // posts that belong on a later page).
    const candidatePosts = await gatherForYouCandidates({
      viewerId: currentUserId,
      followingIds: context.followingIds ?? [],
      userBehavior: context.userBehavior as CandidateUserBehavior | undefined,
      seenPostIds,
    });

    // Rank posts
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

    // Apply score-based cursor filtering
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

    // Deduplicate
    const uniqueMap = new Map<string, RankedCandidate>();
    for (const post of posts) {
      const id = readCandidateId(post);
      if (id && !uniqueMap.has(id)) uniqueMap.set(id, post);
    }
    const deduped = Array.from(uniqueMap.values());

    // Never blank: when the viewer has exhausted unseen ranked content — the
    // seen-posts set excludes everything recent (it caps at 1000 with a 30-min
    // TTL, so a heavy scrolling session can drain the unseen pool) or simply no
    // candidate matched — fall back to popular discovery instead of returning an
    // empty For You. fetchPopular does NOT exclude seen posts, so it always has
    // content to show.
    if (deduped.length === 0) {
      return this.fetchPopular(cursor, limit, context);
    }

    // Thread slicing on the FULL ranked candidate pool (not just the top-limit),
    // so a multi-post thread by one author is grouped into a SINGLE slice before
    // any author spacing. Slicing is cheap (grouping + one bounded thread-children
    // query); the expensive hydration below runs only on the page we emit.
    const { slices: rawSlices } = await threadSlicingService.sliceFeed(deduped, {
      enableThreadGrouping: true,
      enableReplyContext: true,
      maxSliceSize: MtnConfig.feed.maxSliceSize,
      viewerId: currentUserId,
    });

    // Author-diversity rerank at the SLICE level over the WHOLE pool, BEFORE
    // truncating to the page. Spacing/capping then DROPS a prolific author's
    // excess past `limit` (other authors backfill from the pool) instead of
    // dumping it consecutively at the page tail. Operating on slices keeps
    // threads intact — a thread is one slice / one unit, never split.
    const diversifiedSlices = diversifyByAuthor(rawSlices, sliceAuthorKey);

    // Take the page from the diversified order, then hydrate ONLY those slices.
    const hasMore = diversifiedSlices.length > limit;
    const pageSlices = hasMore ? diversifiedSlices.slice(0, limit) : diversifiedSlices;

    const hydratedSlices = await postHydrationService.hydrateSlices(pageSlices, {
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

    // Build the next cursor from the MINIMUM finalScore among the slices actually
    // EMITTED on this page (the score watermark). The next page filters
    // score < this min, so no emitted slice is ever re-shown. The reranker may
    // defer higher-scored excess (capped / over-gap) PAST the page; that excess
    // is intentionally not carried forward — the cap is the user's "fewer of this
    // author" preference doing its job. Scored against the RAW pre-hydration
    // slices so the score is available regardless of hydration.
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
          logger.warn('[ForYouFeed] Cursor did not advance', { cursor, nextCursor: sliceCursor });
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

  private async fetchPopular(cursor: string | undefined, limit: number, context: FeedContext): Promise<FeedAPIResponse> {
    const match: any = {
      visibility: 'public',
      $and: [{ $or: [{ boostOf: null }, { boostOf: { $exists: false } }] }],
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
      nextCursor,
      totalCount: hydrated.length,
    };
  }
}
