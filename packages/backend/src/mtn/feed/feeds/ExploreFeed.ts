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
import { diversifyByAuthor } from '../diversifyByAuthor';
import { RankedCandidate, sliceAuthorKey, sliceCursorAnchor } from '../rankedCandidate';
import { DISCOVERY_SAFE_MATCH } from '../feedSafety';
import { logger } from '../../../utils/logger';
import mongoose from 'mongoose';

/** A resolved Explore relevance multiplier and the viewer signals it derived from. */
interface ExploreRelevance {
  /**
   * The Mongo aggregation expression that evaluates to the per-post relevance
   * multiplier (a number in `[1, maxBoost]`). For an anonymous / no-signal
   * viewer this is the literal `1` — exactly neutral.
   */
  expr: unknown;
  /** Preferred topic slugs used (post-weight-threshold), for diagnostics/tests. */
  topics: string[];
  /** Preferred languages used, for diagnostics/tests. */
  languages: string[];
  /** Viewer region used (or undefined), for diagnostics/tests. */
  region?: string;
}

export class ExploreFeed implements FeedAPI {
  readonly descriptor = 'explore' as const;

  /**
   * Build the bounded RELEVANCE multiplier for the authenticated Explore feed
   * from the viewer's learned signals in `context`. The result is folded into
   * the ranking aggregation as a multiplier on top of engagement×recency.
   *
   * It is a SOFT lift, never a filter: a post matching the viewer's preferred
   * topics / language / region scores higher, but a non-matching post keeps its
   * full engagement×recency score and still appears (serendipity). The combined
   * multiplier is clamped to `exploreRelevance.maxBoost` so no single viewer
   * signal can dominate the discovery order.
   *
   * Returns a neutral `1` expression when the viewer is anonymous or has no
   * usable signals, so anonymous Explore is byte-for-byte unchanged.
   */
  private resolveRelevanceSignals(context: FeedContext): ExploreRelevance {
    const cfg = MtnConfig.ranking.exploreRelevance;
    const NEUTRAL: ExploreRelevance = { expr: 1, topics: [], languages: [], region: undefined };

    // No viewer → no signals → neutral (anonymous Explore unchanged).
    if (!context.currentUserId) return NEUTRAL;

    const behavior = context.userBehavior as
      | {
          preferredTopics?: Array<{ topic?: string; weight?: number }>;
          preferredLanguages?: string[];
        }
      | undefined;

    const candidateCfg = MtnConfig.feed.candidateSources;

    // Preferred topic slugs above the discovery weight floor, by descending
    // weight, bounded by the same cap the For You discovery sources use so the
    // `$in` array stays small.
    const topics = (behavior?.preferredTopics ?? [])
      .filter((t): t is { topic: string; weight?: number } =>
        typeof t.topic === 'string' && t.topic.length > 0)
      .sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0))
      .slice(0, candidateCfg.maxPreferredTopics)
      .map((t) => t.topic.toLowerCase());

    const languages = (behavior?.preferredLanguages ?? [])
      .filter((l): l is string => typeof l === 'string' && l.length > 0)
      .slice(0, candidateCfg.maxPreferredLanguages);

    const region = typeof context.viewerRegion === 'string' && context.viewerRegion.length > 0
      ? context.viewerRegion
      : undefined;

    // No usable signal at all → neutral.
    if (topics.length === 0 && languages.length === 0 && !region) return NEUTRAL;

    // Per-dimension multiplier: `weight` when the post matches, else 1.0. The
    // matches are computed against the projected classification fields; an
    // absent classification field yields no match (multiplier 1.0) for that
    // post, so un-classified posts are simply neutral.
    const factors: unknown[] = [];

    if (topics.length > 0) {
      factors.push({
        $cond: [
          {
            // True when the post's classified topics intersect the viewer's.
            $gt: [
              { $size: { $setIntersection: [{ $ifNull: ['$postClassification.topics', []] }, topics] } },
              0,
            ],
          },
          cfg.topicMatch,
          1,
        ],
      });
    }

    if (languages.length > 0) {
      // ANY-overlap: boost when the viewer's preferred languages intersect the
      // post's `postClassification.languages` (the single canonical multi-language
      // field). An un-classified post has no array → empty intersection → neutral
      // (multiplier 1.0).
      factors.push({
        $cond: [
          {
            $gt: [
              {
                $size: {
                  $setIntersection: [{ $ifNull: ['$postClassification.languages', []] }, languages],
                },
              },
              0,
            ],
          },
          cfg.languageMatch,
          1,
        ],
      });
    }

    if (region) {
      factors.push({
        $cond: [
          { $eq: ['$postClassification.region', region] },
          cfg.regionMatch,
          1,
        ],
      });
    }

    // Combined multiplier = product of the matched factors, clamped to maxBoost.
    const product = factors.length === 1 ? factors[0] : { $multiply: factors };
    const expr = { $min: [{ $literal: cfg.maxBoost }, product] };

    return { expr, topics, languages, region };
  }

  async peekLatest(context: FeedContext): Promise<HydratedPost | undefined> {
    const trendingCutoff = new Date(Date.now() - MtnConfig.feed.trendingWindowMs);
    const match: Record<string, unknown> = {
      visibility: 'public',
      createdAt: { $gte: trendingCutoff },
      $and: [
        { $or: [{ parentPostId: null }, { parentPostId: { $exists: false } }] },
        { $or: [{ boostOf: null }, { boostOf: { $exists: false } }] },
      ],
    };
    const post = await Post.findOne(match)
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

    // RELEVANCE signals for a LOGGED-IN viewer (a light, bounded lift — NOT a
    // filter, NOT personalization-via-follows). Explore stays DISCOVERY of
    // non-followed content; these only NUDGE matching posts up the
    // engagement×recency order so they aren't buried. Anonymous viewers pass no
    // signals, so the multiplier collapses to 1.0 (behavior unchanged).
    const relevance = this.resolveRelevanceSignals(context);

    const trendingCutoff = new Date(Date.now() - MtnConfig.feed.trendingWindowMs);

    // Explore is a discovery surface (content from users the viewer does NOT
    // follow), so it is SFW for safe-for-work viewers: the shared
    // `DISCOVERY_SAFE_MATCH` excludes classifier/metadata/federation-flagged
    // sensitive content and NSFW-hashtag posts at the query level. When the viewer
    // opted in (`showSensitiveContent`), the exclusion is skipped so sensitive
    // posts are eligible.
    const allowSensitive = context.showSensitiveContent === true;
    const match: Record<string, unknown> = {
      visibility: 'public',
      status: 'published',
      createdAt: { $gte: trendingCutoff },
      ...(allowSensitive ? {} : DISCOVERY_SAFE_MATCH),
      $and: [
        { $or: [{ parentPostId: null }, { parentPostId: { $exists: false } }] },
        { $or: [{ boostOf: null }, { boostOf: { $exists: false } }] },
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
    // Half-life of the exponential recency decay, in hours, sourced from the
    // shared ranking config so Explore decays consistently with ForYou.
    const halfLifeHours = MtnConfig.ranking.recency.halfLifeMs / (1000 * 60 * 60);
    // Use a Date (not a number) — Mongo `$subtract` needs Date − Date to yield
    // milliseconds; subtracting a Date from a double throws TypeMismatch
    // ("can't $subtract date from double") and 500s the whole Explore feed.
    const now = new Date();

    const pipeline: any[] = [
      { $match: match },
      {
        $project: {
          _id: 1, oxyUserId: 1, federation: 1, createdAt: 1, visibility: 1, type: 1,
          parentPostId: 1, boostOf: 1, quoteOf: 1, threadId: 1,
          content: 1, stats: 1, metadata: 1, hashtags: 1, mentions: 1, language: 1,
          // Classification signals consumed by the (logged-in) relevance boost
          // below. Cheap to project; absent on un-classified posts (relevance
          // then no-ops to neutral for that post).
          'postClassification.topics': 1,
          'postClassification.languages': 1,
          'postClassification.region': 1,
        },
      },
      {
        $addFields: {
          // Raw weighted engagement (likes/boosts/comments), then log-scaled
          // below so a runaway-popular post can't dominate the discovery feed.
          rawEngagement: {
            $add: [
              { $multiply: [{ $ifNull: ['$stats.likesCount', 0] }, cfg.likeWeight] },
              { $multiply: [{ $ifNull: ['$stats.boostsCount', 0] }, cfg.boostWeight] },
              { $multiply: [{ $ifNull: ['$stats.commentsCount', 0] }, cfg.commentWeight] },
            ],
          },
          // Age in hours = (now - createdAt) / 3,600,000 ms.
          ageHours: {
            $divide: [{ $subtract: [now, '$createdAt'] }, 1000 * 60 * 60],
          },
        },
      },
      {
        $addFields: {
          // MULTIPLICATIVE exponential recency decay: 0.5 ^ (age / halfLife),
          // equivalent to ForYou's `Math.pow(0.5, ageHours / halfLife)`. Replaces
          // the old ADDITIVE `engagement + recencyBoost*10` that let a brand-new
          // zero-engagement post outrank genuinely trending content.
          recencyDecay: {
            $pow: [0.5, { $divide: ['$ageHours', halfLifeHours] }],
          },
          // Log-scaled engagement with a POPULARITY FLOOR (+1): the floor keeps
          // recency meaningful for low/zero-engagement posts (so the discovery
          // feed isn't empty of fresh content) while engagement still lifts
          // posts that are actually resonating.
          engagementBase: {
            $add: [1, { $ln: { $add: [1, '$rawEngagement'] } }],
          },
        },
      },
      {
        $addFields: {
          // Bounded RELEVANCE multiplier for a logged-in viewer (1.0 for
          // anonymous / no-signal viewers). Each matched dimension multiplies a
          // configured weight in; the product is clamped to `maxBoost` so a
          // single viewer can never overwhelm the trending order. This is a
          // SOFT lift — non-matching posts keep their engagement×recency score
          // and still surface (serendipity preserved).
          relevanceBoost: relevance.expr,
        },
      },
      {
        $addFields: {
          finalScore: {
            $multiply: ['$engagementBase', '$recencyDecay', '$relevanceBoost'],
          },
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

    // Overfetch a candidate POOL (not just limit+1) so the author-diversity
    // rerank below has other authors to backfill with when it caps/spaces a
    // prolific author — same candidateMultiplier ForYou uses.
    const candidatePoolSize = limit * MtnConfig.feed.candidateMultiplier;
    pipeline.push({ $sort: { finalScore: -1, _id: -1 } }, { $limit: candidatePoolSize + 1 });

    const posts = (await Post.aggregate(pipeline).option({ maxTimeMS: 5000 })) as RankedCandidate[];

    // Thread slicing (self-thread grouping only for explore) on the FULL pool, so
    // a thread is one slice before author spacing. Slicing is cheap; hydration
    // (expensive) runs only on the emitted page below.
    const { slices: rawSlices } = await threadSlicingService.sliceFeed(posts, {
      enableThreadGrouping: true,
      enableReplyContext: false,
      maxSliceSize: MtnConfig.feed.maxSliceSize,
      viewerId: currentUserId,
    });

    // Author-diversity rerank over the WHOLE pool BEFORE truncating to the page,
    // so a prolific author's capped/over-gap excess falls PAST `limit` (other
    // authors backfill) instead of clustering at the page tail. Threads stay
    // intact — a thread is one slice / one unit, never split.
    const diversifiedSlices = diversifyByAuthor(rawSlices, sliceAuthorKey);

    const hasMore = diversifiedSlices.length > limit;
    const pageSlices = hasMore ? diversifiedSlices.slice(0, limit) : diversifiedSlices;

    const hydratedSlices = await postHydrationService.hydrateSlices(pageSlices, {
      viewerId: currentUserId,
      oxyClient: context.oxyClient,
      maxDepth: 0,
      includeLinkMetadata: true,
    });

    // Next cursor = MINIMUM finalScore among the EMITTED page slices (the score
    // watermark). The next page filters score < this min, so no emitted slice is
    // re-shown; deferred excess scored above the cursor is intentionally dropped
    // (the cap is the "fewer of this author" preference doing its job).
    let nextCursor: string | undefined;
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
        nextCursor = ScoreCursor.build(anchorScore, anchorId);
        if (!didCursorAdvance(nextCursor, cursor)) {
          logger.warn('[ExploreFeed] Cursor did not advance', { cursor, nextCursor });
          nextCursor = undefined;
        }
      }
    }

    return FeedResponseBuilder.buildSlicedResponse({
      slices: hydratedSlices,
      limit,
      previousCursor: cursor,
      cursorFromLastSlice: nextCursor,
      hasMore,
    });
  }
}
