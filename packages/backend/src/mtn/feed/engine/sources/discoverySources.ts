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
import { ScoreCursor } from '../../CursorBuilder';
import { DISCOVERY_SAFE_MATCH, filterDiscoverable } from '../../feedSafety';
import type { CandidatePost, FeedEngineContext, SourceModule } from '../types';

/** Standard engagement composite used by the popular aggregations. */
function engagementScoreExpr() {
  const cfg = MtnConfig.ranking.engagement;
  return {
    $add: [
      { $multiply: [{ $ifNull: ['$stats.likesCount', 0] }, cfg.likeWeight] },
      { $multiply: [{ $ifNull: ['$stats.boostsCount', 0] }, cfg.boostWeight] },
      { $multiply: [{ $ifNull: ['$stats.commentsCount', 0] }, cfg.commentWeight] },
    ],
  };
}

/** `videos`: ranked candidate query for video posts (wraps `buildVideosQuery`). */
export const videosSource: SourceModule = {
  id: 'videos',
  kind: 'source',
  userComposable: false,
  gather: async (ctx, _params, cap) => {
    const seenPostIds = ctx.seenPostIds ?? [];
    const parsed = ScoreCursor.parse(ctx.cursor);
    const match = {
      ...FeedQueryBuilder.buildVideosQuery(seenPostIds, parsed?.id, {
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
    const seenPostIds = ctx.seenPostIds ?? [];
    const parsed = ScoreCursor.parse(ctx.cursor);
    const match = {
      ...FeedQueryBuilder.buildMediaFeedQuery(seenPostIds, parsed?.id),
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

    const excludeUserIds: string[] = [];
    if (currentUserId) excludeUserIds.push(currentUserId);
    if (followingIds?.length) excludeUserIds.push(...followingIds);

    const relevance = resolveExploreRelevance(ctx);
    const trendingCutoff = new Date(Date.now() - MtnConfig.feed.trendingWindowMs);
    const match: Record<string, unknown> = {
      visibility: 'public',
      status: 'published',
      createdAt: { $gte: trendingCutoff },
      ...DISCOVERY_SAFE_MATCH,
      $and: [
        { $or: [{ parentPostId: null }, { parentPostId: { $exists: false } }] },
        { $or: [{ boostOf: null }, { boostOf: { $exists: false } }] },
      ],
    };
    if (excludeUserIds.length > 0) {
      match.oxyUserId = { $nin: excludeUserIds };
    }

    let cursorScore: number | undefined;
    let cursorId: string | undefined;
    if (ctx.cursor) {
      const parsed = ScoreCursor.parse(ctx.cursor);
      if (parsed && parsed.score !== Infinity) {
        cursorScore = parsed.score;
        cursorId = parsed.id;
      }
    }

    const halfLifeHours = MtnConfig.ranking.recency.halfLifeMs / (1000 * 60 * 60);
    const now = new Date();

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
    if (ctx.cursor && mongoose.Types.ObjectId.isValid(ctx.cursor)) {
      baseMatch._id = { $lt: new mongoose.Types.ObjectId(ctx.cursor) };
    }

    // A recency window bounds the engagement scan through the
    // `{ visibility, status, createdAt }` index; the never-blank fallback widens
    // (7d → 30d → unbounded) so this source (For You anonymous + never-blank
    // fallback) is never starved on a low-traffic instance. Cutoff computed
    // per-call inside the helper.
    const runPopular = (cutoff: Date | undefined): Promise<CandidatePost[]> =>
      Post.aggregate<CandidatePost>([
        { $match: cutoff ? { ...baseMatch, createdAt: { $gte: cutoff } } : baseMatch },
        {
          $project: {
            _id: 1, oxyUserId: 1, authorship: 1, federation: 1, createdAt: 1, visibility: 1, type: 1,
            parentPostId: 1, boostOf: 1, quoteOf: 1, threadId: 1,
            content: 1, stats: 1, metadata: 1, hashtags: 1, mentions: 1, language: 1,
            'postClassification.sensitive': 1,
          },
        },
        { $addFields: { engagementScore: engagementScoreExpr() } },
        { $sort: { engagementScore: -1, createdAt: -1 } },
        { $limit: cap },
      ]).option({ maxTimeMS: 5000 });

    const posts = await fetchWithRecencyFallback(cap, runPopular);

    return filterDiscoverable(posts);
  },
};

/** Shared engagement-sorted popular aggregation for the media/video anonymous fallbacks. */
async function gatherPopularByQuery(match: Record<string, unknown>, cap: number): Promise<CandidatePost[]> {
  return await Post.aggregate<CandidatePost>([
    { $match: match },
    {
      $project: {
        _id: 1, oxyUserId: 1, authorship: 1, federation: 1, createdAt: 1, visibility: 1, type: 1,
        parentPostId: 1, boostOf: 1, quoteOf: 1, threadId: 1,
        content: 1, stats: 1, metadata: 1, hashtags: 1, mentions: 1, language: 1,
      },
    },
    { $addFields: { engagementScore: engagementScoreExpr() } },
    { $sort: { engagementScore: -1, createdAt: -1, _id: -1 } },
    { $limit: cap },
  ]).option({ maxTimeMS: 5000 });
}

/** `popularVideos`: anonymous Videos fallback (wraps `VideosFeed.fetchPopular`). */
export const popularVideosSource: SourceModule = {
  id: 'popularVideos',
  kind: 'source',
  userComposable: false,
  gather: async (ctx, _params, cap) =>
    gatherPopularByQuery(
      {
        ...FeedQueryBuilder.buildVideosQuery([], ctx.cursor, {
          orientation: ctx.videoFilters?.orientation,
          minDurationSec: ctx.videoFilters?.minDurationSec,
        }),
        ...DISCOVERY_SAFE_MATCH,
      },
      cap,
    ),
};

/** `popularMedia`: anonymous Media fallback (wraps `MediaFeed.fetchPopular`). */
export const popularMediaSource: SourceModule = {
  id: 'popularMedia',
  kind: 'source',
  userComposable: false,
  gather: async (ctx, _params, cap) =>
    gatherPopularByQuery(
      { ...FeedQueryBuilder.buildMediaFeedQuery([], ctx.cursor), ...DISCOVERY_SAFE_MATCH },
      cap,
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
