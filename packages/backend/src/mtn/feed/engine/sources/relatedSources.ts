/**
 * Infra-heavier "related / discovery" source modules (Phase 4).
 *
 * These need more than a lean single-index query: overlap-based similarity
 * (`moreLikeThis`), geo/region proximity (`nearby`), and follower-growth ranking
 * (`risingCreators`, backed by a periodic snapshot job). They follow the Phase 1/2
 * authoring pattern exactly — a bounded query selecting `FEED_FIELDS`,
 * `.maxTimeMS(5000)`, capped to `cap`, soft-failing to `[]` — and never
 * reimplement ranking/hydration (the engine wraps them). SFW gating uses the
 * shared {@link DISCOVERY_SAFE_MATCH} unless the viewer opted into sensitive
 * content.
 */

import mongoose from 'mongoose';
import { PostVisibility, MtnConfig } from '@mention/shared-types';
import { Post } from '../../../../models/Post';
import { AuthorFollowerSnapshot } from '../../../../models/AuthorFollowerSnapshot';
import { FEED_FIELDS } from '../../FeedAPI';
import { ChronoCursor } from '../../CursorBuilder';
import { DISCOVERY_SAFE_MATCH } from '../../feedSafety';
import { logger } from '../../../../utils/logger';
import type { CandidatePost, FeedEngineContext, SourceModule } from '../types';

/**
 * Overfetch factor for `moreLikeThis`: fetch this many × the page cap of recent
 * candidates so the in-memory overlap re-rank has a meaningful pool to sort,
 * bounded by {@link MORE_LIKE_THIS_MAX_POOL}.
 */
const MORE_LIKE_THIS_POOL_MULTIPLIER = 4;

/** Hard ceiling on the `moreLikeThis` candidate pool (memory + sort bound). */
const MORE_LIKE_THIS_MAX_POOL = 500;

/** Cap on the number of seed topics/hashtags fed into the `$in` match. */
const MAX_SEED_TERMS = 20;

/** Normalize a loose string array: lowercase, trim empties, dedupe, cap length. */
function normalizeTerms(value: unknown, cap: number): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (typeof raw !== 'string') continue;
    const term = raw.trim().toLowerCase();
    if (term) seen.add(term);
    if (seen.size >= cap) break;
  }
  return Array.from(seen);
}

/** The similarity seed: the topics/hashtags/author a `moreLikeThis` query matches on. */
interface MoreLikeThisSeed {
  topics: string[];
  hashtags: string[];
  authorId: string;
  /** The seed post's id to exclude from results (only on the postId-driven path). */
  excludeId: mongoose.Types.ObjectId | null;
}

/**
 * Whether `ctx`'s viewer is authorized to use a `postId`-driven seed — i.e. to
 * read the seed post's topics/hashtags/author. Without this gate a viewer could
 * pass a PRIVATE / FOLLOWERS_ONLY post's id and infer its classification from the
 * returned "related" posts (the results are public/SFW, but the SEED's attributes
 * would leak). Mirrors the post-visibility rule used elsewhere:
 * PUBLIC is open; the viewer's own posts are always allowed; FOLLOWERS_ONLY
 * requires the viewer to follow the author; everything else is denied.
 *
 * NOTE: block / restrict relationships are not resolved onto the feed engine
 * context pre-hydration, so this enforces post VISIBILITY only. A viewer blocked
 * by the seed's author could still seed on that author's PUBLIC post — consistent
 * with the public/SFW nature of the results.
 */
function isSeedAuthorized(visibility: unknown, seedAuthorId: string, ctx: FeedEngineContext): boolean {
  if (visibility === PostVisibility.PUBLIC) return true;
  if (seedAuthorId && seedAuthorId === ctx.currentUserId) return true;
  if (visibility === PostVisibility.FOLLOWERS_ONLY && (ctx.followingIds ?? []).includes(seedAuthorId)) {
    return true;
  }
  return false;
}

/**
 * Resolve the similarity seed from params. `postId` loads the seed post and reads
 * its classification topics / hashtags / author; otherwise the seed is taken
 * directly from `{ topics, hashtags, authorId }` (builder-composable, no lookup).
 * Returns `null` when a `postId` was given but is invalid / not found, or when the
 * viewer is not authorized to view that seed post (see {@link isSeedAuthorized}).
 * The direct builder path performs no lookup and cannot leak.
 */
async function resolveSeed(
  params: Record<string, unknown>,
  ctx: FeedEngineContext,
): Promise<MoreLikeThisSeed | null> {
  const postId = typeof params.postId === 'string' ? params.postId : '';

  if (postId) {
    if (!mongoose.Types.ObjectId.isValid(postId)) return null;
    let seedPost:
      | { postClassification?: { topics?: unknown }; hashtags?: unknown; oxyUserId?: unknown; visibility?: unknown }
      | null;
    try {
      seedPost = await Post.findById(postId)
        .select('postClassification.topics hashtags oxyUserId visibility')
        .lean();
    } catch (error) {
      logger.warn('[moreLikeThis source] Failed to load seed post', { postId, error });
      return null;
    }
    if (!seedPost) return null;
    const authorId = typeof seedPost.oxyUserId === 'string' ? seedPost.oxyUserId : '';
    if (!isSeedAuthorized(seedPost.visibility, authorId, ctx)) return null;
    return {
      topics: normalizeTerms(seedPost.postClassification?.topics, MAX_SEED_TERMS),
      hashtags: normalizeTerms(seedPost.hashtags, MAX_SEED_TERMS),
      authorId,
      excludeId: new mongoose.Types.ObjectId(postId),
    };
  }

  return {
    topics: normalizeTerms(params.topics, MAX_SEED_TERMS),
    hashtags: normalizeTerms(params.hashtags, MAX_SEED_TERMS),
    authorId: typeof params.authorId === 'string' ? params.authorId : '',
    excludeId: null,
  };
}

/** Count a candidate's topic/hashtag/author overlap with the seed (the relevance score). */
function overlapScore(
  post: CandidatePost,
  topicSet: Set<string>,
  tagSet: Set<string>,
  authorId: string,
): number {
  let score = 0;
  const topics = post.postClassification?.topics ?? [];
  for (const topic of topics) {
    if (topicSet.has(topic.toLowerCase())) score += 1;
  }
  const hashtags = post.hashtags ?? [];
  for (const tag of hashtags) {
    if (tagSet.has(tag.toLowerCase())) score += 1;
  }
  if (authorId && post.oxyUserId === authorId) score += 1;
  return score;
}

/** Epoch ms of a candidate's `createdAt` (0 when absent), for the recency tie-break. */
function createdAtMs(post: CandidatePost): number {
  return new Date(post.createdAt ?? 0).getTime();
}

/**
 * `moreLikeThis`: OVERLAP-based "related posts" — no embeddings. Resolves a seed
 * (a `postId`, or a direct `{ topics, hashtags, authorId }`) and returns recent
 * public SFW posts that share any of its classified topics, hashtags, or author,
 * ranked by how many of those overlap (`finalScore`). The seed post itself and
 * boosts (empty bodies) are excluded. Bounded overfetch + in-memory re-rank.
 */
export const moreLikeThisSource: SourceModule = {
  id: 'moreLikeThis',
  kind: 'source',
  userComposable: true,
  gather: async (ctx, params, cap) => {
    const seed = await resolveSeed(params, ctx);
    if (!seed) return [];
    if (seed.topics.length === 0 && seed.hashtags.length === 0 && !seed.authorId) return [];

    const orConditions: Record<string, unknown>[] = [];
    if (seed.topics.length > 0) orConditions.push({ 'postClassification.topics': { $in: seed.topics } });
    if (seed.hashtags.length > 0) orConditions.push({ hashtags: { $in: seed.hashtags } });
    if (seed.authorId) orConditions.push({ oxyUserId: seed.authorId });

    const windowStart = new Date(Date.now() - MtnConfig.feed.candidateSources.recencyWindowMs);
    const match: Record<string, unknown> = {
      visibility: PostVisibility.PUBLIC,
      status: 'published',
      createdAt: { $gte: windowStart },
      ...DISCOVERY_SAFE_MATCH,
      $and: [
        { $or: orConditions },
        { $or: [{ boostOf: null }, { boostOf: { $exists: false } }] },
      ],
    };
    if (seed.excludeId) match._id = { $ne: seed.excludeId };

    const poolSize = Math.min(cap * MORE_LIKE_THIS_POOL_MULTIPLIER, MORE_LIKE_THIS_MAX_POOL);
    const candidates = await Post.find(match)
      .select(FEED_FIELDS)
      .sort({ _id: -1 })
      .limit(poolSize)
      .maxTimeMS(5000)
      .lean<CandidatePost[]>();

    const topicSet = new Set(seed.topics);
    const tagSet = new Set(seed.hashtags);
    return candidates
      .map((post) => {
        post.finalScore = overlapScore(post, topicSet, tagSet, seed.authorId);
        return post;
      })
      .sort((a, b) => {
        const diff = (b.finalScore ?? 0) - (a.finalScore ?? 0);
        return diff !== 0 ? diff : createdAtMs(b) - createdAtMs(a);
      })
      .slice(0, cap);
  },
};

/** Default search radius (km) for `nearby` when the caller supplies none. */
const NEARBY_DEFAULT_RADIUS_KM = 50;

/** Hard ceiling on the `nearby` search radius (km). */
const NEARBY_MAX_RADIUS_KM = 500;

/** Coerce a loose value to a finite number, or `null`. Accepts numeric strings. */
function toFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * `nearby` / `local`: BEST-EFFORT proximity discovery.
 *
 * When valid `{ lat, lng }` are supplied, returns public SFW posts within
 * `radiusKm` (default {@link NEARBY_DEFAULT_RADIUS_KM}, clamped to
 * {@link NEARBY_MAX_RADIUS_KM}) via a `$near` geo query on the Post `location`
 * GeoJSON point (2dsphere-indexed), ordered by ascending distance.
 *
 * DATA CAVEAT: post `location` coordinates are SPARSE today (only posts that
 * explicitly attach a creation location carry them), so the geo path can return
 * little. When no coordinates are given (or they are out of range) the source
 * falls back to the viewer's learned `postClassification.region` match — a coarse
 * "content from your region" approximation that keeps the feed non-empty until
 * location data improves. Returns `[]` when neither is available.
 */
export const nearbySource: SourceModule = {
  id: 'nearby',
  kind: 'source',
  userComposable: true,
  gather: async (ctx, params, cap) => {
    const safety = DISCOVERY_SAFE_MATCH;
    const lat = toFiniteNumber(params.lat);
    const lng = toFiniteNumber(params.lng);

    if (lat !== null && lng !== null && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) {
      const radiusKm = clamp(
        toFiniteNumber(params.radiusKm) ?? NEARBY_DEFAULT_RADIUS_KM,
        1,
        NEARBY_MAX_RADIUS_KM,
      );
      const match: Record<string, unknown> = {
        visibility: PostVisibility.PUBLIC,
        status: 'published',
        ...safety,
        // `$near` requires the `location` 2dsphere index and orders results by
        // ascending distance, so no additional sort is applied.
        location: {
          $near: {
            $geometry: { type: 'Point', coordinates: [lng, lat] },
            $maxDistance: radiusKm * 1000,
          },
        },
        $and: [{ $or: [{ boostOf: null }, { boostOf: { $exists: false } }] }],
      };
      return await Post.find(match)
        .select(FEED_FIELDS)
        .limit(cap)
        .maxTimeMS(5000)
        .lean<CandidatePost[]>();
    }

    const region =
      typeof ctx.viewerRegion === 'string' && ctx.viewerRegion.trim() ? ctx.viewerRegion : '';
    if (!region) return [];

    const match: Record<string, unknown> = {
      'postClassification.region': region,
      visibility: PostVisibility.PUBLIC,
      status: 'published',
      ...safety,
    };
    ChronoCursor.applyToQuery(match, ctx.cursor);
    return await Post.find(match)
      .select(FEED_FIELDS)
      .sort({ _id: -1 })
      .limit(cap)
      .maxTimeMS(5000)
      .lean<CandidatePost[]>();
  },
};

/** Window over which follower-growth delta is measured for `risingCreators`. 7 days. */
const RISING_CREATORS_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Denominator floor for the growth RATE (`delta / max(baseline, smoothing)`). It
 * keeps the rate finite for zero/near-zero baselines while still favouring
 * genuine up-and-comers over already-huge accounts adding the same absolute
 * count.
 */
const RISING_FOLLOWER_SMOOTHING = 10;

/** Max rising authors whose posts are fetched per request. */
const RISING_CREATORS_MAX_AUTHORS = 100;

/** Overfetch factor for the rising authors' recent posts (in-memory rate re-rank). */
const RISING_CREATORS_POST_MULTIPLIER = 3;

/** A grouped follower-count row (first/last snapshot within the window) per author. */
interface SnapshotGroup {
  _id: unknown;
  first: number;
  last: number;
}

/**
 * `risingCreators`: creators gaining followers fastest right now.
 *
 * Reads {@link AuthorFollowerSnapshot} (populated by the leader-gated
 * `followerSnapshotJob`), computes each author's follower-growth delta over the
 * window (last − first snapshot), ranks by growth RATE (smoothed so up-and-comers
 * beat already-huge accounts), and returns those authors' recent public SFW
 * top-level posts, scored (`finalScore`) by their author's growth rate.
 *
 * INFRA CAVEAT: inert until the snapshot job has recorded at least two samples
 * spanning the window for some authors — with no snapshots (or no positive
 * growth) it soft-fails to `[]`.
 */
export const risingCreatorsSource: SourceModule = {
  id: 'risingCreators',
  kind: 'source',
  userComposable: true,
  gather: async (ctx, _params, cap) => {
    const windowStart = new Date(Date.now() - RISING_CREATORS_WINDOW_MS);

    let groups: SnapshotGroup[];
    try {
      groups = await AuthorFollowerSnapshot.aggregate<SnapshotGroup>([
        { $match: { at: { $gte: windowStart } } },
        { $sort: { at: 1 } },
        {
          $group: {
            _id: '$oxyUserId',
            first: { $first: '$followerCount' },
            last: { $last: '$followerCount' },
          },
        },
      ]).option({ maxTimeMS: 5000 });
    } catch (error) {
      logger.warn('[risingCreators source] Failed to aggregate follower snapshots', error);
      return [];
    }

    const ranked = groups
      .map((group) => {
        const first = typeof group.first === 'number' ? group.first : 0;
        const last = typeof group.last === 'number' ? group.last : 0;
        const delta = last - first;
        return {
          id: group._id ? String(group._id) : '',
          delta,
          rate: delta / Math.max(first, RISING_FOLLOWER_SMOOTHING),
        };
      })
      .filter((group) => group.id.length > 0 && group.delta > 0)
      .sort((a, b) => b.rate - a.rate)
      .slice(0, RISING_CREATORS_MAX_AUTHORS);
    if (ranked.length === 0) return [];

    const rateById = new Map(ranked.map((group) => [group.id, group.rate]));
    const authorIds = ranked.map((group) => group.id);

    const match: Record<string, unknown> = {
      oxyUserId: { $in: authorIds },
      visibility: PostVisibility.PUBLIC,
      status: 'published',
      createdAt: { $gte: windowStart },
      ...DISCOVERY_SAFE_MATCH,
      $and: [
        { $or: [{ parentPostId: null }, { parentPostId: { $exists: false } }] },
        { $or: [{ boostOf: null }, { boostOf: { $exists: false } }] },
      ],
    };

    const poolSize = Math.min(cap * RISING_CREATORS_POST_MULTIPLIER, MORE_LIKE_THIS_MAX_POOL);
    const posts = await Post.find(match)
      .select(FEED_FIELDS)
      .sort({ _id: -1 })
      .limit(poolSize)
      .maxTimeMS(5000)
      .lean<CandidatePost[]>();

    return posts
      .map((post) => {
        post.finalScore = typeof post.oxyUserId === 'string' ? rateById.get(post.oxyUserId) ?? 0 : 0;
        return post;
      })
      .sort((a, b) => {
        const diff = (b.finalScore ?? 0) - (a.finalScore ?? 0);
        return diff !== 0 ? diff : createdAtMs(b) - createdAtMs(a);
      })
      .slice(0, cap);
  },
};

export const relatedSourceModules: SourceModule[] = [
  moreLikeThisSource,
  nearbySource,
  risingCreatorsSource,
];
