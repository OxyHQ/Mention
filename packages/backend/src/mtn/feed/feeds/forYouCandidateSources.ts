/**
 * For You — multi-source candidate generation.
 *
 * The authenticated For You feed used to rank only the global NEWEST public
 * posts, so ranking never even SAW relevant posts from followed / affinity /
 * preferred-topic authors unless they happened to fall inside the global-recency
 * window. On a noisy federated instance that pool is mostly irrelevant.
 *
 * This module replaces that single query with a UNION of bounded, parallel
 * candidate sub-queries — each consuming a different personalization signal —
 * and returns the merged, de-duplicated pool. The caller (`ForYouFeed.fetch`)
 * feeds that pool into the EXISTING rank → dedup → never-blank → diversify →
 * page → cursor pipeline unchanged.
 *
 * Sources:
 *   1. FOLLOWING  — posts from authors the viewer follows (incl. federated +
 *      subscribed-list members already merged into `followingIds`).
 *   2. AFFINITY   — posts from authors the viewer engages with
 *      (`userBehavior.preferredAuthors` ∪ `ContentAffinityService`).
 *   3. TOPICS     — DISCOVERY: posts whose classification topics match the
 *      viewer's preferred topics (indexed `for_you_topics_idx`).
 *   4. LANGUAGE   — DISCOVERY: posts in the viewer's preferred language(s)
 *      (indexed `for_you_language_idx`).
 *   5. REGION     — DISCOVERY: posts in the viewer's region
 *      (indexed `postClassification.region`).
 *   6. TRENDING   — DISCOVERY: recent high-engagement posts.
 *   7. GLOBAL     — DISCOVERY: recent public posts (the old behavior), SMALL cap,
 *      for serendipity.
 *
 * SAFETY: the DISCOVERY sources (topics, language, region, trending, global)
 * EXCLUDE sensitive / NSFW content — the viewer did not opt into them. The
 * FOLLOWING and AFFINITY sources do NOT over-filter sensitive content: the
 * viewer chose those authors, mirroring existing behavior.
 *
 * Each source is recency-windowed, per-source capped, and projects only
 * {@link FEED_FIELDS}. The merged pool is additionally bounded by
 * `MtnConfig.feed.candidateSources.maxPool`. All caps/windows live in
 * `shared-types` config — no magic numbers here.
 */

import mongoose from 'mongoose';
import { MtnConfig, PostVisibility } from '@mention/shared-types';
import { Post } from '../../../models/Post';
import { ContentAffinityService } from '../../../services/ContentAffinityService';
import { isNsfwHashtag } from '../../../services/contentClassification/nsfw';
import { logger } from '../../../utils/logger';
import { FEED_FIELDS } from '../FeedAPI';
import { RankedCandidate } from '../rankedCandidate';

/** Minimal viewer-behavior shape this module reads (a lean UserBehavior doc). */
export interface CandidateUserBehavior {
  preferredAuthors?: Array<{ authorId?: string; weight?: number }>;
  preferredTopics?: Array<{ topic?: string; weight?: number }>;
  preferredLanguages?: string[];
  region?: string;
}

/** Inputs to candidate gathering, resolved by `ForYouFeed.fetch`. */
export interface GatherForYouCandidatesParams {
  viewerId: string;
  /** Author ids the viewer follows (already includes federated + subscribed lists). */
  followingIds: string[];
  /** Lean UserBehavior document, or undefined when the viewer has none yet. */
  userBehavior?: CandidateUserBehavior;
  /** Post ids already seen this session — excluded from every source. */
  seenPostIds: string[];
  /** Injectable for testing; defaults to the shared singleton. */
  contentAffinityService?: Pick<ContentAffinityService, 'getContentCandidates'>;
}

/** A lean candidate post carrying the fields the union/dedup path reads. */
type CandidatePost = RankedCandidate & {
  hashtags?: string[];
  postClassification?: { sensitive?: boolean; topics?: string[] };
  metadata?: { isSensitive?: boolean };
  federation?: { sensitive?: boolean };
};

const sharedContentAffinityService = new ContentAffinityService();

/** Valid ObjectIds only, mapped for `$nin`/cursor use. */
function toObjectIds(ids: string[]): mongoose.Types.ObjectId[] {
  return ids
    .filter((id) => mongoose.Types.ObjectId.isValid(id))
    .map((id) => new mongoose.Types.ObjectId(id));
}

/**
 * Base match shared by every source: public, published, NOT a boost (boosts are
 * an intentionally-empty mirror shape; they are surfaced via the original), not
 * already seen, and within the recency window.
 */
function buildBaseMatch(
  seenObjectIds: mongoose.Types.ObjectId[],
  since: Date,
): Record<string, unknown> {
  const and: Record<string, unknown>[] = [
    { $or: [{ boostOf: null }, { boostOf: { $exists: false } }] },
  ];
  if (seenObjectIds.length > 0) {
    and.push({ _id: { $nin: seenObjectIds } });
  }
  return {
    visibility: PostVisibility.PUBLIC,
    status: 'published',
    createdAt: { $gte: since },
    $and: and,
  };
}

/**
 * Add the DISCOVERY safety filter to a match: exclude classifier-flagged
 * sensitive content (`postClassification.sensitive`, `metadata.isSensitive`,
 * `federation.sensitive`). NSFW-hashtag exclusion is applied in code after the
 * fetch (a hashtag blocklist is awkward to express as an index-served query and
 * the pool is already bounded).
 */
function withDiscoverySafety(match: Record<string, unknown>): Record<string, unknown> {
  const and = match.$and as Record<string, unknown>[];
  and.push({ 'postClassification.sensitive': { $ne: true } });
  and.push({ 'metadata.isSensitive': { $ne: true } });
  and.push({ 'federation.sensitive': { $ne: true } });
  return match;
}

/** Run a bounded source query; soft-fail to `[]` so one bad source never sinks the feed. */
async function runSource(
  label: string,
  match: Record<string, unknown>,
  cap: number,
): Promise<CandidatePost[]> {
  try {
    return (await Post.find(match)
      .select(FEED_FIELDS)
      .sort({ createdAt: -1 })
      .limit(cap)
      .maxTimeMS(MtnConfig.feed.candidateSources.maxTimeMS)
      .lean()) as unknown as CandidatePost[];
  } catch (error) {
    logger.warn(`[ForYouCandidates] source "${label}" failed; skipping`, error);
    return [];
  }
}

/**
 * Resolve the AFFINITY author-id set: top `preferredAuthors` (by weight) unioned
 * with `ContentAffinityService` candidates, de-duplicated, with the viewer and
 * already-followed authors removed (FOLLOWING covers those), clamped to the
 * `maxAuthorIds` cap. Soft-fails the affinity-service call to an empty set.
 */
async function resolveAffinityAuthorIds(
  params: GatherForYouCandidatesParams,
): Promise<string[]> {
  const cfg = MtnConfig.feed.candidateSources;
  const followingSet = new Set(params.followingIds);
  const ids = new Set<string>();

  const preferred = (params.userBehavior?.preferredAuthors ?? [])
    .filter((a): a is { authorId: string; weight?: number } => typeof a.authorId === 'string' && a.authorId.length > 0)
    .sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0))
    .slice(0, cfg.maxPreferredAuthors);
  for (const a of preferred) {
    if (a.authorId !== params.viewerId && !followingSet.has(a.authorId)) ids.add(a.authorId);
  }

  try {
    const service = params.contentAffinityService ?? sharedContentAffinityService;
    const affinity = await service.getContentCandidates(params.viewerId, {
      limit: cfg.maxAffinityCandidates,
    });
    for (const c of affinity) {
      if (c.userId && c.userId !== params.viewerId && !followingSet.has(c.userId)) {
        ids.add(c.userId);
      }
    }
  } catch (error) {
    logger.warn('[ForYouCandidates] affinity-service candidates failed; using preferredAuthors only', error);
  }

  return Array.from(ids).slice(0, cfg.maxAuthorIds);
}

/**
 * Gather the multi-source For You candidate pool for an authenticated viewer.
 *
 * Returns a merged, de-duplicated array of lean candidate posts (each carrying
 * {@link FEED_FIELDS}), bounded by `maxPool`. The DISCOVERY sources exclude
 * sensitive/NSFW content; FOLLOWING/AFFINITY do not over-filter. The result is
 * fed verbatim into `ForYouFeed.fetch`'s existing ranking pipeline.
 *
 * NEVER throws: every source soft-fails to empty, so the worst case is an empty
 * pool, which the caller handles via its never-blank `fetchPopular` fallback.
 */
export async function gatherForYouCandidates(
  params: GatherForYouCandidatesParams,
): Promise<CandidatePost[]> {
  const cfg = MtnConfig.feed.candidateSources;
  const seenObjectIds = toObjectIds(params.seenPostIds);
  const since = new Date(Date.now() - cfg.recencyWindowMs);

  const followingIds = params.followingIds.slice(0, cfg.maxAuthorIds);

  const preferredTopics = (params.userBehavior?.preferredTopics ?? [])
    .filter((t): t is { topic: string; weight?: number } => typeof t.topic === 'string' && t.topic.length > 0)
    .sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0))
    .slice(0, cfg.maxPreferredTopics)
    .map((t) => t.topic);

  const preferredLanguages = (params.userBehavior?.preferredLanguages ?? [])
    .filter((l): l is string => typeof l === 'string' && l.length > 0)
    .slice(0, cfg.maxPreferredLanguages);

  const region = typeof params.userBehavior?.region === 'string' ? params.userBehavior.region : undefined;

  const affinityAuthorIds = await resolveAffinityAuthorIds(params);

  // --- FOLLOWING: posts from followed authors (sensitive allowed). ---
  const followingSource: Promise<CandidatePost[]> = followingIds.length > 0
    ? runSource('following', {
        ...buildBaseMatch(seenObjectIds, since),
        oxyUserId: { $in: followingIds },
      }, cfg.perSource.following)
    : Promise.resolve([]);

  // --- AFFINITY: posts from affinity authors (sensitive allowed). ---
  const affinitySource: Promise<CandidatePost[]> = affinityAuthorIds.length > 0
    ? runSource('affinity', {
        ...buildBaseMatch(seenObjectIds, since),
        oxyUserId: { $in: affinityAuthorIds },
      }, cfg.perSource.affinity)
    : Promise.resolve([]);

  // --- TOPICS (DISCOVERY): classification-topic match, sensitive excluded. ---
  const topicsSource: Promise<CandidatePost[]> = preferredTopics.length > 0
    ? runSource('topics', withDiscoverySafety({
        ...buildBaseMatch(seenObjectIds, since),
        'postClassification.topics': { $in: preferredTopics },
      }), cfg.perSource.topics)
    : Promise.resolve([]);

  // --- LANGUAGE (DISCOVERY): preferred-language match, sensitive excluded. ---
  const languageSource: Promise<CandidatePost[]> = preferredLanguages.length > 0
    ? runSource('language', withDiscoverySafety({
        ...buildBaseMatch(seenObjectIds, since),
        'postClassification.language': { $in: preferredLanguages },
      }), cfg.perSource.language)
    : Promise.resolve([]);

  // --- REGION (DISCOVERY): region match, sensitive excluded. ---
  const regionSource: Promise<CandidatePost[]> = region
    ? runSource('region', withDiscoverySafety({
        ...buildBaseMatch(seenObjectIds, since),
        'postClassification.region': region,
      }), cfg.perSource.region)
    : Promise.resolve([]);

  // --- TRENDING (DISCOVERY): recent high-engagement, sensitive excluded. ---
  // Sorted by a denormalized engagement composite (likes/boosts/comments) so the
  // pool surfaces resonating content; final ranking still re-scores everything.
  const trendingSource: Promise<CandidatePost[]> = (async () => {
    try {
      const eng = MtnConfig.ranking.engagement;
      const match = withDiscoverySafety(buildBaseMatch(seenObjectIds, since));
      match.parentPostId = { $in: [null, undefined] };
      return (await Post.aggregate([
        { $match: match },
        {
          $addFields: {
            _engagementScore: {
              $add: [
                { $multiply: [{ $ifNull: ['$stats.likesCount', 0] }, eng.likeWeight] },
                { $multiply: [{ $ifNull: ['$stats.boostsCount', 0] }, eng.boostWeight] },
                { $multiply: [{ $ifNull: ['$stats.commentsCount', 0] }, eng.commentWeight] },
              ],
            },
          },
        },
        { $sort: { _engagementScore: -1, createdAt: -1 } },
        { $limit: cfg.perSource.trending },
        { $project: { _engagementScore: 0 } },
      ]).option({ maxTimeMS: cfg.maxTimeMS })) as unknown as CandidatePost[];
    } catch (error) {
      logger.warn('[ForYouCandidates] source "trending" failed; skipping', error);
      return [];
    }
  })();

  // --- GLOBAL (DISCOVERY): recent public, small cap, sensitive excluded. ---
  const globalSource: Promise<CandidatePost[]> = runSource(
    'global',
    withDiscoverySafety(buildBaseMatch(seenObjectIds, since)),
    cfg.perSource.global,
  );

  const [following, affinity, topics, language, regionPosts, trending, global] = await Promise.all([
    followingSource,
    affinitySource,
    topicsSource,
    languageSource,
    regionSource,
    trendingSource,
    globalSource,
  ]);

  // Each source is tagged TRUSTED (the viewer chose this content) or DISCOVERY.
  // TRUSTED content may include sensitive/NSFW (the viewer follows/engages with
  // those authors); DISCOVERY content has already been query-filtered for
  // classifier-sensitivity and here additionally drops NSFW-hashtag posts.
  //
  // Merge order = priority: TRUSTED first, then DISCOVERY. A full `maxPool` clamp
  // therefore keeps the viewer's chosen content over pure discovery.
  const sources: Array<{ posts: CandidatePost[]; discovery: boolean }> = [
    { posts: following, discovery: false },
    { posts: affinity, discovery: false },
    { posts: topics, discovery: true },
    { posts: language, discovery: true },
    { posts: regionPosts, discovery: true },
    { posts: trending, discovery: true },
    { posts: global, discovery: true },
  ];

  const merged = new Map<string, CandidatePost>();
  for (const { posts, discovery } of sources) {
    for (const post of posts) {
      if (merged.size >= cfg.maxPool) break;
      const id = post?._id?.toString();
      if (!id || merged.has(id)) continue;
      // Drop NSFW-hashtag posts from DISCOVERY only; never over-filter trusted content.
      if (discovery && containsNsfwHashtag(post)) continue;
      merged.set(id, post);
    }
    if (merged.size >= cfg.maxPool) break;
  }

  return Array.from(merged.values());
}

/**
 * Whether a post carries any NSFW-blocklisted hashtag. Applied in code (not as a
 * query) because the blocklist is awkward to express as an index-served filter
 * and the candidate pool is already bounded. Only the top-level `hashtags` array
 * is checked (the canonical normalized read form).
 */
function containsNsfwHashtag(post: CandidatePost): boolean {
  const tags = post.hashtags;
  if (!Array.isArray(tags) || tags.length === 0) return false;
  return tags.some((tag) => isNsfwHashtag(tag));
}
