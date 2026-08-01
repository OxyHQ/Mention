/**
 * Discovery / media source modules — wrap the existing Videos, Media, Explore
 * candidate queries and the anonymous/never-blank "popular" fallbacks. Each
 * reproduces the pre-existing feed's exact query + aggregation; the engine adds
 * the ranking/slicing/pagination wrapper.
 *
 * Internal (not user-composable): they mirror bespoke preset feeds.
 */

import mongoose from 'mongoose';
import { MtnConfig } from '@mention/shared-types';
import { Post } from '../../../../models/Post';
import { FeedQueryBuilder } from '../../../../utils/feedQueryBuilder';
import { fetchWithRecencyFallback } from '../../../../utils/feedUtils';
import { FEED_FIELDS } from '../../FeedAPI';
import { ScoreCursor, type ScoreCursorData } from '../../CursorBuilder';
import { DISCOVERY_SAFE_MATCH, filterDiscoverable } from '../../feedSafety';
import { notAReplyClause } from '../../../../utils/postReply';
import type { CandidatePost, FeedEngineContext, SourceModule } from '../types';

/**
 * The standard engagement composite used by the popular / explore / trending
 * aggregations, as a Mongo aggregation expression. THE single source of truth for
 * the Mongo composite so the discovery lanes can never drift.
 *
 * The boost term splits the total boosts into their native and federated subsets
 * (`stats.federatedBoostsCount` counts inbound ActivityPub Announces): the native
 * subset — `max(0, boostsCount − federatedBoostsCount)`, floored so an over-count
 * can never go negative — is weighted at `boostWeight`, and the federated subset at
 * the deliberately-lower `federatedBoostWeight`. `$ifNull` keeps it null-safe: a
 * doc missing `federatedBoostsCount` (every pre-backfill post) reads 0, collapsing
 * the term back to `boostsCount · boostWeight`. Likes/comments terms are unchanged.
 */
export function engagementScoreExpr(): Record<string, unknown> {
  const cfg = MtnConfig.ranking.engagement;
  const boosts = { $ifNull: ['$stats.boostsCount', 0] };
  const federatedBoosts = { $ifNull: ['$stats.federatedBoostsCount', 0] };
  const nativeBoosts = { $max: [0, { $subtract: [boosts, federatedBoosts] }] };
  return {
    $add: [
      { $multiply: [{ $ifNull: ['$stats.likesCount', 0] }, cfg.likeWeight] },
      { $multiply: [nativeBoosts, cfg.boostWeight] },
      { $multiply: [federatedBoosts, cfg.federatedBoostWeight] },
      { $multiply: [{ $ifNull: ['$stats.commentsCount', 0] }, cfg.commentWeight] },
    ],
  };
}

/**
 * WHY NEITHER OF THE TWO SOURCES BELOW APPLIES THE CURSOR — the question this
 * file will be asked again.
 *
 * `videos` and `media` are RANKED sources, not pre-scored ones and not
 * chronological ones. They hand the engine an unordered candidate POOL; the
 * engine scores it in process (`FeedRankingService.rankPosts`) and paginates the
 * RESULT by a score window (`FeedEngine.finalizeRanked`). Nothing about their
 * output is ordered by `_id`, so an `_id` bound here narrows the pool on an axis
 * neither layer sorts by: a post that scored just BELOW the cursor — exactly the
 * page-two candidate the score window is there to admit — is dropped before
 * ranking ever sees it, and since the bound only ever moves down it can never
 * come back in that session. Federated posts lose the most: `_id` is their IMPORT
 * time, so one backfilled minutes ago carries a near-maximal `_id` however old
 * the post itself is, and is the first thing an `_id` bound cuts.
 *
 * Nothing is lost by dropping it. Forward progress is the SCORE window's job and
 * it needs no help: every item on the emitted page scores at or above that page's
 * cursor anchor, so the window excludes the whole page by construction — even
 * from a source that re-offers the identical pool every time. The seen set
 * (`ctx.seenPostIds`, threaded into the match below) is what slides the candidate
 * window forward so the pool keeps refilling.
 *
 * This mirrors For You, the other ranked in-process-scored feed:
 * `GatherForYouCandidatesParams` takes a seen set and NO cursor. Cursor-in-the-
 * source is correct only where source order IS page order — the chronological
 * lanes (`ChronoCursor.applyToQuery` over a `_id`/`createdAt` sort) and the
 * pre-scored `exploreSource`, which keysets on the `finalScore` it sorts by.
 */

/** `videos`: ranked candidate query for video posts (wraps `buildVideosQuery`). */
export const videosSource: SourceModule = {
  id: 'videos',
  kind: 'source',
  userComposable: false,
  gather: async (ctx, _params, cap) => {
    const match = {
      ...FeedQueryBuilder.buildVideosQuery(ctx.seenPostIds ?? [], {
        orientation: ctx.videoFilters?.orientation,
        minDurationSec: ctx.videoFilters?.minDurationSec,
      }),
      ...DISCOVERY_SAFE_MATCH,
    };
    return await Post.find(match)
      .select(FEED_FIELDS)
      .sort({ createdAt: -1 })
      .limit(cap)
      .maxTimeMS(5000)
      .lean<CandidatePost[]>();
  },
};

/** `media`: ranked candidate query for media posts (wraps `buildMediaFeedQuery`). */
export const mediaSource: SourceModule = {
  id: 'media',
  kind: 'source',
  userComposable: false,
  gather: async (ctx, _params, cap) => {
    const match = {
      ...FeedQueryBuilder.buildMediaFeedQuery(ctx.seenPostIds ?? []),
      ...DISCOVERY_SAFE_MATCH,
    };
    return await Post.find(match)
      .select(FEED_FIELDS)
      .sort({ createdAt: -1 })
      .limit(cap)
      .maxTimeMS(5000)
      .lean<CandidatePost[]>();
  },
};

/** A resolved Explore relevance multiplier expression + the viewer signals it used. */
interface ExploreRelevance {
  expr: unknown;
}

/**
 * Build the bounded RELEVANCE multiplier for the authenticated Explore feed from
 * the viewer's learned signals — a SOFT lift on top of engagement×recency (never
 * a filter). Neutral `1` for anonymous / no-signal viewers. Reproduced from the
 * legacy `ExploreFeed.resolveRelevanceSignals`.
 */
function resolveExploreRelevance(ctx: FeedEngineContext): ExploreRelevance {
  const cfg = MtnConfig.ranking.exploreRelevance;
  const candidateCfg = MtnConfig.feed.candidateSources;
  const NEUTRAL: ExploreRelevance = { expr: 1 };

  if (!ctx.currentUserId) return NEUTRAL;

  const behavior = ctx.userBehavior as
    | { preferredTopics?: Array<{ topic?: string; weight?: number }>; preferredLanguages?: string[] }
    | undefined;

  const topics = (behavior?.preferredTopics ?? [])
    .filter((t): t is { topic: string; weight?: number } => typeof t.topic === 'string' && t.topic.length > 0)
    .sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0))
    .slice(0, candidateCfg.maxPreferredTopics)
    .map((t) => t.topic.toLowerCase());

  const languages = (behavior?.preferredLanguages ?? [])
    .filter((l): l is string => typeof l === 'string' && l.length > 0)
    .slice(0, candidateCfg.maxPreferredLanguages);

  const region = typeof ctx.viewerRegion === 'string' && ctx.viewerRegion.length > 0
    ? ctx.viewerRegion
    : undefined;

  if (topics.length === 0 && languages.length === 0 && !region) return NEUTRAL;

  const factors: unknown[] = [];

  if (topics.length > 0) {
    factors.push({
      $cond: [
        {
          $gt: [
            { $size: { $setIntersection: [{ $ifNull: ['$postClassification.topics', []] }, { $literal: topics }] } },
            0,
          ],
        },
        cfg.topicMatch,
        1,
      ],
    });
  }

  if (languages.length > 0) {
    factors.push({
      $cond: [
        {
          $gt: [
            { $size: { $setIntersection: [{ $ifNull: ['$postClassification.languages', []] }, { $literal: languages }] } },
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
      $cond: [{ $eq: ['$postClassification.region', { $literal: region }] }, cfg.regionMatch, 1],
    });
  }

  const product = factors.length === 1 ? factors[0] : { $multiply: factors };
  return { expr: { $min: [{ $literal: cfg.maxBoost }, product] } };
}

/**
 * `explore`: pre-scored discovery aggregation (engagement×recency×relevance) of
 * non-followed public SFW content. Returns candidates decorated with a
 * `finalScore` and sorted, with the score cursor already applied — the engine's
 * pre-scored ranked path slices/diversifies/paginates it. Reproduced from the
 * legacy `ExploreFeed.fetch`.
 */
export const exploreSource: SourceModule = {
  id: 'explore',
  kind: 'source',
  userComposable: false,
  gather: async (ctx, _params, cap) => {
    const { currentUserId, followingIds } = ctx;
    const parsedCursor = ScoreCursor.parse(ctx.cursor);
    const rankingAsOf = parsedCursor?.asOf ?? ctx.rankingAsOf ?? Date.now();

    const excludeUserIds: string[] = [];
    if (currentUserId) excludeUserIds.push(currentUserId);
    if (followingIds?.length) excludeUserIds.push(...followingIds);

    const relevance = resolveExploreRelevance(ctx);
    const rankingCeiling = new Date(rankingAsOf);
    const trendingCutoff = new Date(rankingAsOf - MtnConfig.feed.trendingWindowMs);
    const match: Record<string, unknown> = {
      visibility: 'public',
      status: 'published',
      // Freeze both ends of the candidate window for the whole cursor session:
      // advancing the wall clock or publishing a new post cannot move existing
      // candidates across a page boundary.
      createdAt: { $gte: trendingCutoff, $lte: rankingCeiling },
      ...DISCOVERY_SAFE_MATCH,
      $and: [
        notAReplyClause(),
        { $or: [{ boostOf: null }, { boostOf: { $exists: false } }] },
      ],
    };
    if (excludeUserIds.length > 0) {
      match.oxyUserId = { $nin: excludeUserIds };
    }

    const cursorExcludedIds = parsedCursor?.excludeIds ?? [];
    if (cursorExcludedIds.length > 0) {
      match._id = {
        $nin: cursorExcludedIds.map((id) => new mongoose.Types.ObjectId(id)),
      };
    }

    let cursorScore: number | undefined;
    let cursorId: string | undefined;
    if (parsedCursor && parsedCursor.score !== Infinity) {
      cursorScore = parsedCursor.score;
      cursorId = parsedCursor.id;
    }

    const halfLifeHours = MtnConfig.ranking.recency.halfLifeMs / (1000 * 60 * 60);
    const now = rankingCeiling;

    const pipeline: mongoose.PipelineStage[] = [
      { $match: match },
      {
        $project: {
          _id: 1, oxyUserId: 1, authorship: 1, federation: 1, createdAt: 1, visibility: 1, type: 1,
          parentPostId: 1, boostOf: 1, quoteOf: 1, threadId: 1,
          content: 1, stats: 1, metadata: 1, hashtags: 1, mentions: 1, language: 1,
          'postClassification.topics': 1,
          'postClassification.languages': 1,
          'postClassification.region': 1,
        },
      },
      {
        $addFields: {
          rawEngagement: engagementScoreExpr(),
          ageHours: { $divide: [{ $subtract: [now, '$createdAt'] }, 1000 * 60 * 60] },
        },
      },
      {
        $addFields: {
          recencyDecay: { $pow: [0.5, { $divide: ['$ageHours', halfLifeHours] }] },
          engagementBase: { $add: [1, { $ln: { $add: [1, '$rawEngagement'] } }] },
        },
      },
      { $addFields: { relevanceBoost: relevance.expr } },
      { $addFields: { finalScore: { $multiply: ['$engagementBase', '$recencyDecay', '$relevanceBoost'] } } },
    ];

    if (cursorScore !== undefined && cursorId) {
      pipeline.push({
        $match: {
          $or: [
            { finalScore: { $lt: cursorScore } },
            { $and: [{ finalScore: cursorScore }, { _id: { $lt: new mongoose.Types.ObjectId(cursorId) } }] },
          ],
        },
      });
    }

    pipeline.push({ $sort: { finalScore: -1, _id: -1 } }, { $limit: cap + 1 });

    return await Post.aggregate<CandidatePost>(pipeline).option({ maxTimeMS: 5000 });
  },
};

/**
 * `popular`: For You anonymous + never-blank fallback — engagement-sorted recent
 * public posts, SFW for safe-for-work viewers. Reproduced from the legacy
 * `ForYouFeed.fetchPopular`.
 */
export const popularSource: SourceModule = {
  id: 'popular',
  kind: 'source',
  userComposable: false,
  gather: async (ctx, _params, cap) => {
    const baseMatch: Record<string, unknown> = {
      visibility: 'public',
      status: 'published',
      ...DISCOVERY_SAFE_MATCH,
      $and: [{ $or: [{ boostOf: null }, { boostOf: { $exists: false } }] }],
    };

    // Exclude what the viewer has already been shown. The video and media
    // fallbacks thread the seen set through their query builders; this one built
    // its match by hand and never did, so the FIRST fallback page could re-serve
    // exactly the posts the ranked pages had just run out of — the most visible
    // moment to repeat yourself. Later pages were already fine, because the keyset
    // carries the boundary forward; it is only the ranked→fallback transition,
    // where there is no keyset yet, that had nothing to exclude on.
    const seenObjectIds = (ctx.seenPostIds ?? [])
      .filter((id) => mongoose.Types.ObjectId.isValid(id))
      .map((id) => new mongoose.Types.ObjectId(id));
    if (seenObjectIds.length > 0) {
      (baseMatch.$and as unknown[]).push({ _id: { $nin: seenObjectIds } });
    }
    // This source is BOTH For You anonymous and the authenticated never-blank
    // fallback, so it is handed whatever cursor the ranked feed last emitted —
    // including a `ScoreCursor`, which is not a bare ObjectId. It used to accept a
    // cursor only when the whole string parsed as an ObjectId, so every
    // authenticated fallback page silently became page ONE: an authenticated
    // viewer past their unseen pool was served the same most-engaged posts over
    // and over, with `hasMore: true`.
    const parsedCursor = ScoreCursor.parse(ctx.cursor);
    const cursorScopedMatch = withExcludedIds(baseMatch, parsedCursor?.excludeIds);
    const keyset = popularKeysetStage(parsedCursor);

    // A recency window bounds the engagement scan through the
    // `{ visibility, status, createdAt }` index; the never-blank fallback widens
    // (7d → 30d → unbounded) so this source (For You anonymous + never-blank
    // fallback) is never starved on a low-traffic instance. Cutoff computed
    // per-call inside the helper.
    const runPopular = (cutoff: Date | undefined): Promise<CandidatePost[]> => {
      const pipeline: mongoose.PipelineStage[] = [
        {
          $match: cutoff
            ? { ...cursorScopedMatch, createdAt: { $gte: cutoff } }
            : cursorScopedMatch,
        },
        {
          $project: {
            _id: 1, oxyUserId: 1, authorship: 1, federation: 1, createdAt: 1, visibility: 1, type: 1,
            parentPostId: 1, boostOf: 1, quoteOf: 1, threadId: 1,
            content: 1, stats: 1, metadata: 1, hashtags: 1, mentions: 1, language: 1,
            'postClassification.sensitive': 1,
          },
        },
        { $addFields: { engagementScore: engagementScoreExpr() } },
      ];
      if (keyset) pipeline.push(keyset);
      // `_id` completes the order. Without it `{engagementScore, createdAt}` is not
      // total — two posts published in the same millisecond with equal engagement
      // have no defined relative position, so paging over them is undefined
      // regardless of how the cursor is shaped.
      pipeline.push({ $sort: POPULAR_SORT }, { $limit: cap });
      return Post.aggregate<CandidatePost>(pipeline).option({ maxTimeMS: 5000 });
    };

    const posts = await fetchWithRecencyFallback(cap, runPopular);

    return filterDiscoverable(posts);
  },
};

/** The sort every popular source orders by, and therefore the keyset it must page on. */
export const POPULAR_SORT = { engagementScore: -1, createdAt: -1, _id: -1 } as const;

/**
 * The keyset stage that continues a popular page, matching {@link POPULAR_SORT}.
 *
 * THREE keys, where `explore` needs two: `engagementScore` carries no recency
 * term, so every zero-engagement post ties on it and `createdAt` is doing real
 * ordering work rather than breaking rare ties. Ordering that bulk by `_id`
 * instead would be wrong for federated posts, whose `_id` is their IMPORT time
 * and bears no relation to when they were written.
 *
 * Returns `undefined` unless the cursor is one THIS regime minted and it can
 * express the full key. Two independent requirements, both necessary:
 *
 *  - PROVENANCE (`fromPopularFallback`). `parsed.score` becomes a bound on
 *    `engagementScore` here, so a cursor whose score is a ranking `finalScore` —
 *    which a `neverBlank` feed hands over the moment its ranked pool empties —
 *    would compare two different quantities. Absence of `tiebreakAt` happens to
 *    exclude today's ranked cursors as well, but that is a coincidence of the
 *    current sort keys, not a statement about where the score came from: give the
 *    ranked sort a `createdAt` tiebreak and the coincidence inverts silently.
 *  - COMPLETENESS (`tiebreakAt`). A legacy bare ObjectId, or a v1 cursor minted
 *    before `tiebreakAt` existed, cannot say which `createdAt` the page stopped at.
 *
 * Failing either, the caller relies on the cursor's bounded `excludeIds` for that
 * single page instead of filtering on an axis it is not sorted by — precisely the
 * defect this replaces: an `_id` filter under an engagement sort both repeats
 * high-engagement posts and permanently skips newer, less-engaged ones.
 */
function popularKeysetStage(parsed?: ScoreCursorData): mongoose.PipelineStage.Match | undefined {
  if (!parsed || !parsed.fromPopularFallback) return undefined;
  if (!Number.isFinite(parsed.score) || parsed.tiebreakAt === undefined) return undefined;
  if (!mongoose.Types.ObjectId.isValid(parsed.id)) return undefined;

  const boundaryAt = new Date(parsed.tiebreakAt);
  const boundaryId = new mongoose.Types.ObjectId(parsed.id);
  return {
    $match: {
      $or: [
        { engagementScore: { $lt: parsed.score } },
        { engagementScore: parsed.score, createdAt: { $lt: boundaryAt } },
        { engagementScore: parsed.score, createdAt: boundaryAt, _id: { $lt: boundaryId } },
      ],
    },
  };
}

/**
 * Add the cursor's bounded exclusion list as one more `$and` clause. Appending
 * rather than assigning `_id` is deliberate: these matches already carry `$and`
 * and may constrain `_id` themselves, and an assignment would silently drop
 * whichever clause lost.
 */
function withExcludedIds(
  match: Record<string, unknown>,
  excludeIds?: readonly string[],
): Record<string, unknown> {
  const ids = (excludeIds ?? []).filter((id) => mongoose.Types.ObjectId.isValid(id));
  if (ids.length === 0) return match;

  const existing = Array.isArray(match.$and) ? match.$and : [];
  return {
    ...match,
    $and: [...existing, { _id: { $nin: ids.map((id) => new mongoose.Types.ObjectId(id)) } }],
  };
}

/** Shared engagement-sorted popular aggregation for the media/video fallbacks. */
async function gatherPopularByQuery(
  match: Record<string, unknown>,
  cap: number,
  cursor?: string,
): Promise<CandidatePost[]> {
  const parsed = ScoreCursor.parse(cursor);
  const pipeline: mongoose.PipelineStage[] = [
    { $match: withExcludedIds(match, parsed?.excludeIds) },
    {
      $project: {
        _id: 1, oxyUserId: 1, authorship: 1, federation: 1, createdAt: 1, visibility: 1, type: 1,
        parentPostId: 1, boostOf: 1, quoteOf: 1, threadId: 1,
        content: 1, stats: 1, metadata: 1, hashtags: 1, mentions: 1, language: 1,
      },
    },
    { $addFields: { engagementScore: engagementScoreExpr() } },
  ];

  const keyset = popularKeysetStage(parsed);
  if (keyset) pipeline.push(keyset);

  pipeline.push({ $sort: POPULAR_SORT }, { $limit: cap });
  return await Post.aggregate<CandidatePost>(pipeline).option({ maxTimeMS: 5000 });
}

/**
 * `popularVideos`: the Videos fallback (wraps `VideosFeed.fetchPopular`).
 *
 * The cursor goes to {@link gatherPopularByQuery}, which keysets on the
 * `{engagementScore, createdAt, _id}` axis this source actually sorts by. The
 * builder only supplies the CONTENT predicate plus the seen set, so a fallback
 * page cannot re-serve what the ranked pages already showed — the reason this
 * path could repeat forever.
 */
export const popularVideosSource: SourceModule = {
  id: 'popularVideos',
  kind: 'source',
  userComposable: false,
  gather: async (ctx, _params, cap) =>
    gatherPopularByQuery(
      {
        ...FeedQueryBuilder.buildVideosQuery(ctx.seenPostIds ?? [], {
          orientation: ctx.videoFilters?.orientation,
          minDurationSec: ctx.videoFilters?.minDurationSec,
        }),
        ...DISCOVERY_SAFE_MATCH,
      },
      cap,
      ctx.cursor,
    ),
};

/** `popularMedia`: the Media fallback (wraps `MediaFeed.fetchPopular`). Same shape as above. */
export const popularMediaSource: SourceModule = {
  id: 'popularMedia',
  kind: 'source',
  userComposable: false,
  gather: async (ctx, _params, cap) =>
    gatherPopularByQuery(
      {
        ...FeedQueryBuilder.buildMediaFeedQuery(ctx.seenPostIds ?? []),
        ...DISCOVERY_SAFE_MATCH,
      },
      cap,
      ctx.cursor,
    ),
};

export const discoverySourceModules: SourceModule[] = [
  videosSource,
  mediaSource,
  exploreSource,
  popularSource,
  popularVideosSource,
  popularMediaSource,
];
