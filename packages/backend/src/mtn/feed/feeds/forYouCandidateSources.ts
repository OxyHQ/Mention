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
 * SAFETY: For You is the curated algorithmic feed and must be uniformly SFW.
 * The DISCOVERY sources (topics, language, region, trending, global) EXCLUDE
 * sensitive / NSFW content at the query level, and a single sensitive/NSFW guard
 * is additionally applied to the MERGED pool (post-union, pre-rank) so EVERY
 * source — including FOLLOWING and AFFINITY — is covered. The separate
 * chronological Following feed is unaffected; only For You is filtered here.
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
import { SENSITIVE_EXCLUDE_MATCH, isSensitivePost } from '../feedSafety';
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
  /**
   * Whether the viewer opted in to sensitive/NSFW content. When `true`, the
   * per-source discovery sensitivity filter and the merged-pool sensitive/NSFW
   * guard are skipped so sensitive posts are eligible. Defaults to `false`
   * (safe-for-work — every source excludes sensitive/NSFW).
   */
  showSensitiveContent?: boolean;
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
 * Add the DISCOVERY sensitive filter to a match by spreading the SHARED
 * {@link SENSITIVE_EXCLUDE_MATCH} clause into its `$and` (so it composes with the
 * base match's own `$and` entries). NSFW-hashtag exclusion is applied to the
 * merged pool in code via the shared {@link isSensitivePost} predicate (it covers
 * every source uniformly, and the pool is already bounded).
 */
function withDiscoverySafety(match: Record<string, unknown>): Record<string, unknown> {
  const and = match.$and as Record<string, unknown>[];
  for (const [field, condition] of Object.entries(SENSITIVE_EXCLUDE_MATCH)) {
    and.push({ [field]: condition });
  }
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

  // Viewer-conditional discovery safety: SFW viewers (the default, incl.
  // undefined) get the sensitive/NSFW exclusion on every DISCOVERY source AND the
  // merged-pool guard below; a viewer who opted in skips both, so sensitive posts
  // are eligible. The centralized predicate/clause is unchanged — only its
  // APPLICATION is conditional here.
  const allowSensitive = params.showSensitiveContent === true;
  const applyDiscoverySafety = (match: Record<string, unknown>): Record<string, unknown> =>
    allowSensitive ? match : withDiscoverySafety(match);

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

  // --- TOPICS (DISCOVERY): classification-topic match, sensitive excluded (SFW). ---
  const topicsSource: Promise<CandidatePost[]> = preferredTopics.length > 0
    ? runSource('topics', applyDiscoverySafety({
        ...buildBaseMatch(seenObjectIds, since),
        'postClassification.topics': { $in: preferredTopics },
      }), cfg.perSource.topics)
    : Promise.resolve([]);

  // --- LANGUAGE (DISCOVERY): preferred-language match, sensitive excluded (SFW). ---
  const languageSource: Promise<CandidatePost[]> = preferredLanguages.length > 0
    ? runSource('language', applyDiscoverySafety({
        ...buildBaseMatch(seenObjectIds, since),
        'postClassification.language': { $in: preferredLanguages },
      }), cfg.perSource.language)
    : Promise.resolve([]);

  // --- REGION (DISCOVERY): region match, sensitive excluded (SFW). ---
  const regionSource: Promise<CandidatePost[]> = region
    ? runSource('region', applyDiscoverySafety({
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
      const match = applyDiscoverySafety(buildBaseMatch(seenObjectIds, since));
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

  // --- GLOBAL (DISCOVERY): recent public, small cap, sensitive excluded (SFW). ---
  const globalSource: Promise<CandidatePost[]> = runSource(
    'global',
    applyDiscoverySafety(buildBaseMatch(seenObjectIds, since)),
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

  // Merge order = priority: TRUSTED (the viewer's chosen following/affinity
  // content) first, then DISCOVERY. A full `maxPool` clamp therefore keeps the
  // viewer's chosen content over pure discovery.
  //
  // SFW GUARD: For a safe-for-work viewer, For You must be uniformly SFW, so a
  // single sensitive/NSFW filter ({@link isSensitivePost}) is applied to the
  // merged pool covering EVERY source — including following and affinity — on top
  // of the per-source discovery query filter. When the viewer opted in
  // (`allowSensitive`), this guard is skipped so sensitive posts from any source
  // remain eligible. (The separate chronological Following feed does not pass
  // through here, so it is unaffected either way.)
  const sources: CandidatePost[][] = [
    following,
    affinity,
    topics,
    language,
    regionPosts,
    trending,
    global,
  ];

  const merged = new Map<string, CandidatePost>();
  for (const posts of sources) {
    for (const post of posts) {
      if (merged.size >= cfg.maxPool) break;
      const id = post?._id?.toString();
      if (!id || merged.has(id)) continue;
      // SFW guard: drop sensitive/NSFW from ALL sources unless the viewer opted in.
      if (!allowSensitive && isSensitivePost(post)) continue;
      merged.set(id, post);
    }
    if (merged.size >= cfg.maxPool) break;
  }

  return Array.from(merged.values());
}
