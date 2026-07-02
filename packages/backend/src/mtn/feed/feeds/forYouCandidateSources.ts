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
 * and returns the merged, de-duplicated pool. The caller feeds that pool into
 * the EXISTING rank → dedup → never-blank → diversify → page → cursor pipeline
 * unchanged.
 *
 * Sources:
 *   1. FOLLOWING  — posts from authors the viewer actually follows (incl. federated).
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
 *
 * The per-lane gather functions are EXPORTED so the composable feed-engine
 * source modules (`engine/sources/forYouSources.ts`) can wrap the EXACT same
 * queries. `gatherForYouCandidates` remains the authoritative merge consumed by
 * the legacy `ForYouFeed` until the engine is authoritative.
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
}

/** Inputs to candidate gathering, resolved by the caller. */
export interface GatherForYouCandidatesParams {
  viewerId: string;
  /** Author ids the viewer actually follows (including accepted federated follows). */
  followingIds: string[];
  /** Author ids from subscribed lists; feed-inclusion only, never follow authorization. */
  subscribedListMemberIds?: string[];
  /** Lean UserBehavior document, or undefined when the viewer has none yet. */
  userBehavior?: CandidateUserBehavior;
  /**
   * The viewer's DOMINANT learned coarse region, resolved by the controller
   * (`UserPreferenceService.getTopRegion`). Drives the REGION discovery source.
   * Best-effort and usually `undefined` (post region is sparse) → the region
   * source is skipped entirely, never an error.
   */
  viewerRegion?: string;
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
export type CandidatePost = RankedCandidate & {
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
 * The recency-window start used by every For You lane. Computed inside the call
 * (never at module scope) so the window tracks request time.
 */
function recencyStart(): Date {
  return new Date(Date.now() - MtnConfig.feed.candidateSources.recencyWindowMs);
}

/** Whether the discovery sensitivity filter should be applied for these params. */
function shouldApplySafety(params: GatherForYouCandidatesParams): boolean {
  return params.showSensitiveContent !== true;
}

/** Followed author ids, clamped to the id-set cap. */
function resolveFollowingIds(params: GatherForYouCandidatesParams): string[] {
  return params.followingIds.slice(0, MtnConfig.feed.candidateSources.maxAuthorIds);
}

/** Subscribed-list author ids minus the viewer + already-followed, clamped. */
function resolveSubscribedListIds(params: GatherForYouCandidatesParams): string[] {
  const followSet = new Set([params.viewerId, ...params.followingIds]);
  return Array.from(new Set(params.subscribedListMemberIds ?? []))
    .filter((id) => id !== params.viewerId && !followSet.has(id))
    .slice(0, MtnConfig.feed.candidateSources.maxAuthorIds);
}

/** Preferred topic slugs (by descending weight), clamped. */
function resolvePreferredTopics(params: GatherForYouCandidatesParams): string[] {
  return (params.userBehavior?.preferredTopics ?? [])
    .filter((t): t is { topic: string; weight?: number } => typeof t.topic === 'string' && t.topic.length > 0)
    .sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0))
    .slice(0, MtnConfig.feed.candidateSources.maxPreferredTopics)
    .map((t) => t.topic);
}

/** Preferred language codes, clamped. */
function resolvePreferredLanguages(params: GatherForYouCandidatesParams): string[] {
  return (params.userBehavior?.preferredLanguages ?? [])
    .filter((l): l is string => typeof l === 'string' && l.length > 0)
    .slice(0, MtnConfig.feed.candidateSources.maxPreferredLanguages);
}

/** The non-empty coarse region string, or undefined. */
function resolveRegion(params: GatherForYouCandidatesParams): string | undefined {
  return typeof params.viewerRegion === 'string' && params.viewerRegion.length > 0
    ? params.viewerRegion
    : undefined;
}

// --- Individual candidate lanes (each self-contained; wrapped by engine sources). ---

/** FOLLOWING: posts from followed authors (sensitive allowed at query level). */
export async function gatherFollowingLane(params: GatherForYouCandidatesParams): Promise<CandidatePost[]> {
  const followingIds = resolveFollowingIds(params);
  if (followingIds.length === 0) return [];
  return runSource('following', {
    ...buildBaseMatch(toObjectIds(params.seenPostIds), recencyStart()),
    oxyUserId: { $in: followingIds },
  }, MtnConfig.feed.candidateSources.perSource.following);
}

/** SUBSCRIBED LISTS: public posts from list authors only (feed-inclusion, not follow). */
export async function gatherSubscribedListsLane(params: GatherForYouCandidatesParams): Promise<CandidatePost[]> {
  const subscribedListMemberIds = resolveSubscribedListIds(params);
  if (subscribedListMemberIds.length === 0) return [];
  return runSource('subscribed-lists', {
    ...buildBaseMatch(toObjectIds(params.seenPostIds), recencyStart()),
    oxyUserId: { $in: subscribedListMemberIds },
  }, MtnConfig.feed.candidateSources.perSource.following);
}

/** AFFINITY: posts from affinity authors (sensitive allowed at query level). */
export async function gatherAffinityLane(params: GatherForYouCandidatesParams): Promise<CandidatePost[]> {
  const affinityAuthorIds = await resolveAffinityAuthorIds(params);
  if (affinityAuthorIds.length === 0) return [];
  return runSource('affinity', {
    ...buildBaseMatch(toObjectIds(params.seenPostIds), recencyStart()),
    oxyUserId: { $in: affinityAuthorIds },
  }, MtnConfig.feed.candidateSources.perSource.affinity);
}

/** TOPICS (DISCOVERY): classification-topic match, sensitive excluded (SFW). */
export async function gatherTopicsLane(params: GatherForYouCandidatesParams): Promise<CandidatePost[]> {
  const preferredTopics = resolvePreferredTopics(params);
  if (preferredTopics.length === 0) return [];
  const match = {
    ...buildBaseMatch(toObjectIds(params.seenPostIds), recencyStart()),
    'postClassification.topics': { $in: preferredTopics },
  };
  return runSource('topics', shouldApplySafety(params) ? withDiscoverySafety(match) : match,
    MtnConfig.feed.candidateSources.perSource.topics);
}

/**
 * LANGUAGE (DISCOVERY): preferred-language match, sensitive excluded (SFW).
 * ANY-overlap over the multikey `postClassification.languages` array.
 */
export async function gatherLanguageLane(params: GatherForYouCandidatesParams): Promise<CandidatePost[]> {
  const preferredLanguages = resolvePreferredLanguages(params);
  if (preferredLanguages.length === 0) return [];
  const match = {
    ...buildBaseMatch(toObjectIds(params.seenPostIds), recencyStart()),
    'postClassification.languages': { $in: preferredLanguages },
  };
  return runSource('language', shouldApplySafety(params) ? withDiscoverySafety(match) : match,
    MtnConfig.feed.candidateSources.perSource.language);
}

/** REGION (DISCOVERY): region match, sensitive excluded (SFW). */
export async function gatherRegionLane(params: GatherForYouCandidatesParams): Promise<CandidatePost[]> {
  const region = resolveRegion(params);
  if (!region) return [];
  const match = {
    ...buildBaseMatch(toObjectIds(params.seenPostIds), recencyStart()),
    'postClassification.region': region,
  };
  return runSource('region', shouldApplySafety(params) ? withDiscoverySafety(match) : match,
    MtnConfig.feed.candidateSources.perSource.region);
}

/**
 * TRENDING (DISCOVERY): recent high-engagement, sensitive excluded. Sorted by a
 * denormalized engagement composite so the pool surfaces resonating content;
 * final ranking still re-scores everything.
 */
export async function gatherTrendingLane(params: GatherForYouCandidatesParams): Promise<CandidatePost[]> {
  const cfg = MtnConfig.feed.candidateSources;
  try {
    const eng = MtnConfig.ranking.engagement;
    const base = buildBaseMatch(toObjectIds(params.seenPostIds), recencyStart());
    const match = shouldApplySafety(params) ? withDiscoverySafety(base) : base;
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
}

/** GLOBAL (DISCOVERY): recent public, small cap, sensitive excluded (SFW). */
export async function gatherGlobalLane(params: GatherForYouCandidatesParams): Promise<CandidatePost[]> {
  const base = buildBaseMatch(toObjectIds(params.seenPostIds), recencyStart());
  return runSource('global', shouldApplySafety(params) ? withDiscoverySafety(base) : base,
    MtnConfig.feed.candidateSources.perSource.global);
}

/**
 * Gather the multi-source For You candidate pool for an authenticated viewer.
 *
 * Returns a merged, de-duplicated array of lean candidate posts (each carrying
 * {@link FEED_FIELDS}), bounded by `maxPool`. The DISCOVERY sources exclude
 * sensitive/NSFW content; FOLLOWING/AFFINITY do not over-filter. The result is
 * fed verbatim into the existing ranking pipeline.
 *
 * NEVER throws: every source soft-fails to empty, so the worst case is an empty
 * pool, which the caller handles via its never-blank `fetchPopular` fallback.
 */
export async function gatherForYouCandidates(
  params: GatherForYouCandidatesParams,
): Promise<CandidatePost[]> {
  const cfg = MtnConfig.feed.candidateSources;
  const allowSensitive = params.showSensitiveContent === true;

  const [following, subscribedLists, affinity, topics, language, regionPosts, trending, global] = await Promise.all([
    gatherFollowingLane(params),
    gatherSubscribedListsLane(params),
    gatherAffinityLane(params),
    gatherTopicsLane(params),
    gatherLanguageLane(params),
    gatherRegionLane(params),
    gatherTrendingLane(params),
    gatherGlobalLane(params),
  ]);

  // Merge order = priority: TRUSTED (the viewer's chosen following/affinity
  // content) first, then DISCOVERY. A full `maxPool` clamp therefore keeps the
  // viewer's chosen content over pure discovery.
  //
  // SFW GUARD: For a safe-for-work viewer, For You must be uniformly SFW, so a
  // single sensitive/NSFW filter ({@link isSensitivePost}) is applied to the
  // merged pool covering EVERY source — including following and affinity — on top
  // of the per-source discovery query filter.
  const sources: CandidatePost[][] = [
    following,
    subscribedLists,
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
