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
 *      viewer's preferred topics.
 *   4. LANGUAGE   — DISCOVERY: posts in the viewer's preferred language(s).
 *   5. REGION     — DISCOVERY: posts in the viewer's region.
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
 * Each source is recency-windowed, per-source capped, and selects only the
 * candidate column set. The merged pool is additionally bounded by
 * `MtnConfig.feed.candidateSources.maxPool`. All caps/windows live in
 * `shared-types` config — no magic numbers here.
 *
 * The per-lane gather functions are EXPORTED so the composable feed-engine
 * source modules (`engine/sources/forYouSources.ts`) can wrap the EXACT same
 * queries.
 */

import { MtnConfig, PostVisibility } from '@mention/shared-types';
import { and, arrayOverlaps, desc, eq, gte, type SQL } from 'drizzle-orm';
import { getDb } from '../../../db/postgres';
import { posts } from '../../../db/schema';
import { assemblePostRecords } from '../../../db/posts/postRepository';
import { ContentAffinityService } from '../../../services/ContentAffinityService';
import { sensitiveExcludeSql, isSensitivePost } from '../feedSafety';
import { logger } from '../../../utils/logger';
import { followedAuthorsSql } from '../../../utils/postAuthorship';
import { excludeSeenSql, notABoostSql } from '../../../utils/feedQueryBuilder';
import { engagementScoreSql } from '../engine/sources/discoverySources';
import type { CandidatePost as EngineCandidatePost } from '../engine/types';
import type { OxyClient } from '../../../utils/privacyHelpers';

/** Minimal viewer-behavior shape this module reads. */
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
  /** Viewer behavior document, or undefined when the viewer has none yet. */
  userBehavior?: CandidateUserBehavior;
  /**
   * The viewer's DOMINANT learned coarse region, resolved by the controller.
   * Drives the REGION discovery source. Best-effort and usually `undefined`
   * (post region is sparse) → the region source is skipped entirely, never an
   * error.
   */
  viewerRegion?: string;
  /** Post ids already seen this session — excluded from every source. */
  seenPostIds: string[];
  /** Authenticated request-scoped Oxy client for affinity privacy/ACL reads. */
  oxyClient?: OxyClient;
  /** Injectable for testing; defaults to the shared singleton. */
  contentAffinityService?: Pick<ContentAffinityService, 'getContentCandidates'>;
}

/** Candidate post — same shape the feed engine sources return. */
export type CandidatePost = EngineCandidatePost;

const sharedContentAffinityService = new ContentAffinityService();

/**
 * Base predicate shared by every source: public, published, NOT a boost (boosts
 * are an intentionally-empty mirror shape; they are surfaced via the original),
 * not already seen, and within the recency window.
 */
function buildBaseConditions(seenPostIds: string[], since: Date): SQL[] {
  const conditions: SQL[] = [
    eq(posts.visibility, PostVisibility.PUBLIC),
    eq(posts.status, 'published'),
    gte(posts.createdAt, since),
    notABoostSql(),
  ];
  const seen = excludeSeenSql(seenPostIds);
  if (seen) conditions.push(seen);
  return conditions;
}

/**
 * Add the DISCOVERY sensitive filter.
 *
 * NSFW-hashtag exclusion is deliberately NOT applied here: it is applied to the
 * merged pool in code via the shared {@link isSensitivePost} predicate, which
 * covers every source uniformly (including following and affinity, which have no
 * query-level safety filter at all) and operates on an already-bounded pool.
 */
function withDiscoverySafety(conditions: SQL[]): SQL[] {
  return [...conditions, sensitiveExcludeSql()];
}

/** Run a bounded source query; soft-fail to `[]` so one bad source never sinks the feed. */
async function runSource(
  label: string,
  conditions: SQL[],
  cap: number,
): Promise<CandidatePost[]> {
  try {
    const db = getDb();
    const rows = await db
      .select()
      .from(posts)
      .where(and(...conditions))
      // `created_at` leads; the id is the uniqueness tiebreak that makes the
      // order total. Sorting by id alone would be meaningless here — see
      // `chronoOrderBy` in `CursorBuilder.ts`.
      .orderBy(desc(posts.createdAt), desc(posts.id))
      .limit(cap);
    return assemblePostRecords(rows, db);
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
      oxyClient: params.oxyClient,
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
  return runSource(
    'following',
    [...buildBaseConditions(params.seenPostIds, recencyStart()), followedAuthorsSql(followingIds)],
    MtnConfig.feed.candidateSources.perSource.following,
  );
}

/** SUBSCRIBED LISTS: public posts from list authors only (feed-inclusion, not follow). */
export async function gatherSubscribedListsLane(params: GatherForYouCandidatesParams): Promise<CandidatePost[]> {
  const subscribedListMemberIds = resolveSubscribedListIds(params);
  if (subscribedListMemberIds.length === 0) return [];
  return runSource(
    'subscribed-lists',
    [
      ...buildBaseConditions(params.seenPostIds, recencyStart()),
      followedAuthorsSql(subscribedListMemberIds),
    ],
    MtnConfig.feed.candidateSources.perSource.following,
  );
}

/** AFFINITY: posts from affinity authors (sensitive allowed at query level). */
export async function gatherAffinityLane(params: GatherForYouCandidatesParams): Promise<CandidatePost[]> {
  const affinityAuthorIds = await resolveAffinityAuthorIds(params);
  if (affinityAuthorIds.length === 0) return [];
  return runSource(
    'affinity',
    [
      ...buildBaseConditions(params.seenPostIds, recencyStart()),
      followedAuthorsSql(affinityAuthorIds),
    ],
    MtnConfig.feed.candidateSources.perSource.affinity,
  );
}

/**
 * TOPICS (DISCOVERY): classification-topic match, sensitive excluded (SFW).
 *
 * ANY-overlap over the `classification_topics` array — `&&` is the direct
 * analogue of Mongo's `$in` against a multikey array field.
 */
export async function gatherTopicsLane(params: GatherForYouCandidatesParams): Promise<CandidatePost[]> {
  const preferredTopics = resolvePreferredTopics(params);
  if (preferredTopics.length === 0) return [];
  return runSource(
    'topics',
    withDiscoverySafety([
      ...buildBaseConditions(params.seenPostIds, recencyStart()),
      arrayOverlaps(posts.classificationTopics, preferredTopics),
    ]),
    MtnConfig.feed.candidateSources.perSource.topics,
  );
}

/**
 * LANGUAGE (DISCOVERY): preferred-language match, sensitive excluded (SFW).
 * ANY-overlap over the multi-language `classification_languages` array.
 */
export async function gatherLanguageLane(params: GatherForYouCandidatesParams): Promise<CandidatePost[]> {
  const preferredLanguages = resolvePreferredLanguages(params);
  if (preferredLanguages.length === 0) return [];
  return runSource(
    'language',
    withDiscoverySafety([
      ...buildBaseConditions(params.seenPostIds, recencyStart()),
      arrayOverlaps(posts.classificationLanguages, preferredLanguages),
    ]),
    MtnConfig.feed.candidateSources.perSource.language,
  );
}

/** REGION (DISCOVERY): region match, sensitive excluded (SFW). */
export async function gatherRegionLane(params: GatherForYouCandidatesParams): Promise<CandidatePost[]> {
  const region = resolveRegion(params);
  if (!region) return [];
  return runSource(
    'region',
    withDiscoverySafety([
      ...buildBaseConditions(params.seenPostIds, recencyStart()),
      eq(posts.classificationRegion, region),
    ]),
    MtnConfig.feed.candidateSources.perSource.region,
  );
}

/**
 * TRENDING (DISCOVERY): recent high-engagement, sensitive excluded. Sorted by
 * the shared engagement composite so the pool surfaces resonating content; final
 * ranking still re-scores everything.
 *
 * Uses `engagementScoreSql` — the SAME composite the discovery lanes use, in
 * which the federated boost subset is dampened, so a burst of remote Announces
 * no longer fakes a trending post.
 */
export async function gatherTrendingLane(params: GatherForYouCandidatesParams): Promise<CandidatePost[]> {
  const cfg = MtnConfig.feed.candidateSources;
  try {
    const db = getDb();
    const engagementScore = engagementScoreSql();
    const conditions = withDiscoverySafety([
      ...buildBaseConditions(params.seenPostIds, recencyStart()),
      eq(posts.isReply, false),
    ]);
    const rows = await db
      .select()
      .from(posts)
      .where(and(...conditions))
      .orderBy(desc(engagementScore), desc(posts.createdAt), desc(posts.id))
      .limit(cfg.perSource.trending);
    return assemblePostRecords(rows, db);
  } catch (error) {
    logger.warn('[ForYouCandidates] source "trending" failed; skipping', error);
    return [];
  }
}

/** GLOBAL (DISCOVERY): recent public, small cap, sensitive excluded (SFW). */
export async function gatherGlobalLane(params: GatherForYouCandidatesParams): Promise<CandidatePost[]> {
  return runSource(
    'global',
    withDiscoverySafety(buildBaseConditions(params.seenPostIds, recencyStart())),
    MtnConfig.feed.candidateSources.perSource.global,
  );
}

/**
 * Gather the multi-source For You candidate pool for an authenticated viewer.
 *
 * Returns a merged, de-duplicated array of candidate posts, bounded by
 * `maxPool`. Discovery sources exclude sensitive at query level; the merged pool
 * also drops sensitive/NSFW posts from every lane (including following). The
 * result is fed verbatim into the existing ranking pipeline.
 *
 * NEVER throws: every source soft-fails to empty, so the worst case is an empty
 * pool, which the caller handles via its never-blank `popular` fallback.
 */
export async function gatherForYouCandidates(
  params: GatherForYouCandidatesParams,
): Promise<CandidatePost[]> {
  const cfg = MtnConfig.feed.candidateSources;

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
  // SFW GUARD: For You must be uniformly SFW — sensitive/NSFW posts are dropped
  // from the merged pool covering EVERY source (including following and affinity).
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
  for (const posts_ of sources) {
    for (const post of posts_) {
      if (merged.size >= cfg.maxPool) break;
      const id = post?.id;
      if (!id || merged.has(id)) continue;
      // SFW guard: drop sensitive/NSFW from ALL sources.
      if (isSensitivePost(post)) continue;
      merged.set(id, post);
    }
    if (merged.size >= cfg.maxPool) break;
  }

  return Array.from(merged.values());
}
