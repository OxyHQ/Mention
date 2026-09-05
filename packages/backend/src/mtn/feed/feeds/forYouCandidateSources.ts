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
 *   4. REGION     — DISCOVERY: posts in the viewer's region.
 *   5. TRENDING   — DISCOVERY: recent high-engagement posts.
 *   6. GLOBAL     — DISCOVERY: recent public posts (the old behavior), SMALL cap,
 *      for serendipity.
 *
 * There is no LANGUAGE lane. There used to be, and it was the wrong shape twice
 * over: it ADDED in-language candidates rather than excluding off-language ones,
 * so it could not stop the other four discovery lanes from filling the pool with
 * posts the reader cannot read; and it keyed off the LEARNED
 * `userBehavior.preferredLanguages`, an append-on-any-interaction array that a
 * skipped post wrote to — so scrolling past German taught the lane to fetch more
 * German. Language is now a PREDICATE on every discovery lane
 * ({@link withDiscoveryGuards}), keyed off the reader's declared languages.
 *
 * ROOTS: every lane draws from {@link buildBaseMatch}, which admits thread ROOTS
 * only — see its doc for why that constraint belongs there and nowhere else.
 *
 * SAFETY: For You is the curated algorithmic feed and must be uniformly SFW.
 * The DISCOVERY sources (topics, region, trending, global) EXCLUDE
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
import { viewerLanguageSql } from '../feedLanguage';
import { logger } from '../../../utils/logger';
import { followedAuthorsSql } from '../../../utils/postAuthorship';
import { excludeSeenSql, notABoostSql } from '../../../utils/feedQueryBuilder';
import { engagementScoreSql } from '../engine/sources/discoverySources';
import { chronoOrderBy } from '../CursorBuilder';
import type { CandidatePost as EngineCandidatePost } from '../engine/types';
import type { OxyClient } from '../../../utils/privacyHelpers';

/** Minimal viewer-behavior shape this module reads. */
export interface CandidateUserBehavior {
  preferredAuthors?: Array<{ authorId?: string; weight?: number }>;
  preferredTopics?: Array<{ topic?: string; weight?: number }>;
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
  /**
   * The viewer's languages as ISO 639-1 BASE subtags, resolved once by
   * `loadViewerFeedContext` (Oxy account, else the request). Applied as a HARD
   * SQL predicate to the DISCOVERY lanes only — see {@link viewerLanguageSql}
   * for why the trusted lanes are exempt. Empty ⇒ no lane is filtered.
   */
  viewerLanguages?: string[];
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
 * Base predicate shared by every source: public, published, a thread ROOT rather
 * than a reply, NOT a boost (boosts are an intentionally-empty mirror shape; they
 * are surfaced via the original), not already seen, and within the recency window.
 *
 * THE ROOT CONSTRAINT LIVES HERE, not in the individual lanes. For You is the
 * curated algorithmic feed, and a reply read outside its thread is close to
 * meaningless — "thank you!", "same", "@someone yes" — so the pool it ranks over
 * must be thread roots. Stating that once, in the definition all eight lanes
 * already funnel through, is what makes the rule true of the whole feed: it was
 * previously applied by ONE lane (trending) and the other six inherited nothing,
 * so a reply excluded from trending re-entered through following, topics,
 * region, affinity, subscribed lists or global. Measured against
 * production on 2026-08-01, replies were 9,330 of the 19,798 public published
 * posts in the 7-day window — 47.1% of the universe the pool is drawn from.
 *
 * The stored `is_reply` column is the shared definition rather than a local
 * `parent_post_id is null`: a federated reply whose parent never resolved carries
 * only `federation_in_reply_to`, and reading the local link alone would let
 * exactly those back in — which is why `derivesReplyIntent` ORs the two encodings
 * once, at write time, into the one column every reader tests.
 *
 * This does NOT touch the chronological Following / List / Topic timelines
 * (`engine/sources/forYouSources.ts`), which build their own matches — seeing
 * replies from accounts you deliberately follow is the conventional behaviour and
 * is deliberately kept. Self-threads also survive: `ThreadSlicingService` pulls a
 * root's children with its OWN query, so the root entering this pool is enough to
 * render the whole chain.
 */
function buildBaseConditions(seenPostIds: string[], since: Date): SQL[] {
  const conditions: SQL[] = [
    eq(posts.visibility, PostVisibility.PUBLIC),
    eq(posts.status, 'published'),
    gte(posts.createdAt, since),
    eq(posts.isReply, false),
    notABoostSql(),
  ];
  const seen = excludeSeenSql(seenPostIds);
  if (seen) conditions.push(seen);
  return conditions;
}

/**
 * Add every DISCOVERY-only guard: the sensitive filter, and the reader-language
 * predicate.
 *
 * Both live HERE, on the one wrapper all five discovery lanes already funnel
 * through, rather than in each lane — because a guard stated per-lane is a guard
 * a new lane inherits nothing of. That is not hypothetical: it is exactly how the
 * root-only rule came to be applied by trending alone while seven other lanes let
 * replies back in (see {@link buildBaseConditions}), and how `popularSource` ended
 * up the one discovery surface with no language predicate at all.
 *
 * Trusted lanes (following / subscribed lists / affinity) deliberately do NOT call
 * this: you chose those authors, so neither guard is yours to apply.
 *
 * NSFW-hashtag exclusion is deliberately NOT applied here: it is applied to the
 * merged pool in code via the shared {@link isSensitivePost} predicate, which
 * covers every source uniformly (including following and affinity, which have no
 * query-level safety filter at all) and operates on an already-bounded pool.
 */
function withDiscoveryGuards(conditions: SQL[], params: GatherForYouCandidatesParams): SQL[] {
  const guarded = [...conditions, sensitiveExcludeSql()];
  const language = viewerLanguageSql(params.viewerLanguages);
  if (language) guarded.push(language);
  return guarded;
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
      // `chronoOrderBy` in `CursorBuilder.ts`, which is now CALLED rather than
      // cited: the bare `desc()` this replaces spells `DESC NULLS FIRST`, which
      // matches none of the chronological indexes on `posts` (drizzle emits
      // `.desc()` in index DDL as `DESC NULLS LAST`), so every lane sorted its
      // whole match set instead of streaming the first `cap` rows out of an
      // index. Measured on 624k posts with a 7-day window: 6.04 ms → 0.54 ms per
      // lane, and the gap grows with the WINDOW rather than the page — seven
      // lanes run this per For You request.
      .orderBy(...chronoOrderBy())
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
    withDiscoveryGuards([
      ...buildBaseConditions(params.seenPostIds, recencyStart()),
      arrayOverlaps(posts.classificationTopics, preferredTopics),
    ], params),
    MtnConfig.feed.candidateSources.perSource.topics,
  );
}

/** REGION (DISCOVERY): region match, sensitive excluded (SFW). */
export async function gatherRegionLane(params: GatherForYouCandidatesParams): Promise<CandidatePost[]> {
  const region = resolveRegion(params);
  if (!region) return [];
  return runSource(
    'region',
    withDiscoveryGuards([
      ...buildBaseConditions(params.seenPostIds, recencyStart()),
      eq(posts.classificationRegion, region),
    ], params),
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
    // The roots-only rule is in `buildBaseConditions` now, so this lane no longer
    // states it — it was the only lane that ever did, which is exactly the bug.
    const conditions = withDiscoveryGuards(
      buildBaseConditions(params.seenPostIds, recencyStart()),
      params,
    );
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
    withDiscoveryGuards(buildBaseConditions(params.seenPostIds, recencyStart()), params),
    MtnConfig.feed.candidateSources.perSource.global,
  );
}

/**
 * Gather the multi-source For You candidate pool for an authenticated viewer.
 *
 * Returns a merged, de-duplicated array of candidate posts, bounded by
 * `maxPool`. Discovery sources exclude sensitive AND off-language posts at query
 * level (see {@link withDiscoveryGuards}); the merged pool also drops
 * sensitive/NSFW posts from every lane (including following). The result is fed
 * verbatim into the existing ranking pipeline.
 *
 * NEVER throws: every source soft-fails to empty, so the worst case is an empty
 * pool, which the caller handles via its never-blank `popular` fallback.
 */
export async function gatherForYouCandidates(
  params: GatherForYouCandidatesParams,
): Promise<CandidatePost[]> {
  const cfg = MtnConfig.feed.candidateSources;

  const [following, subscribedLists, affinity, topics, regionPosts, trending, global] = await Promise.all([
    gatherFollowingLane(params),
    gatherSubscribedListsLane(params),
    gatherAffinityLane(params),
    gatherTopicsLane(params),
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
