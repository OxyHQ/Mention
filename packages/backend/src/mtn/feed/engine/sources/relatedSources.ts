/**
 * Infra-heavier "related / discovery" source modules.
 *
 * These need more than a lean single-index query: overlap-based similarity
 * (`moreLikeThis`), geo/region proximity (`nearby`), and follower-growth ranking
 * (`risingCreators`, backed by a periodic snapshot job). They follow the same
 * authoring pattern as the other sources — a bounded query selecting the
 * candidate column set, capped to `cap`, soft-failing to `[]` — and never
 * reimplement ranking/hydration. SFW gating uses the shared
 * {@link discoverySafeSql} unless the viewer opted into sensitive content.
 */

import { PostVisibility, MtnConfig } from '@mention/shared-types';
import { and, arrayOverlaps, eq, gte, inArray, isNotNull, ne, or, sql, type SQL } from 'drizzle-orm';
import { getDb } from '../../../../db/postgres';
import { authorFollowerSnapshots, posts } from '../../../../db/schema';
import { assemblePostRecords } from '../../../../db/posts/postRepository';
import { chronoCursorSql, chronoOrderBy } from '../../CursorBuilder';
import { discoverySafeSql } from '../../feedSafety';
import { FOLLOWER_SNAPSHOT_INTERVAL_MS } from '../../../../services/followerSnapshotJob';
import { logger } from '../../../../utils/logger';
import { notABoostSql } from '../../../../utils/feedQueryBuilder';
import type { CandidatePost, FeedEngineContext, SourceModule } from '../types';

/**
 * Overfetch factor for `moreLikeThis`: fetch this many × the page cap of recent
 * candidates so the in-memory overlap re-rank has a meaningful pool to sort,
 * bounded by {@link MORE_LIKE_THIS_MAX_POOL}.
 */
const MORE_LIKE_THIS_POOL_MULTIPLIER = 4;

/** Hard ceiling on the `moreLikeThis` candidate pool (memory + sort bound). */
const MORE_LIKE_THIS_MAX_POOL = 500;

/** Cap on the number of seed topics/hashtags fed into the overlap match. */
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
  excludeId: string | null;
}

/**
 * Whether `ctx`'s viewer is authorized to use a `postId`-driven seed — i.e. to
 * read the seed post's topics/hashtags/author. Without this gate a viewer could
 * pass a PRIVATE / FOLLOWERS_ONLY post's id and infer its classification from the
 * returned "related" posts (the results are public/SFW, but the SEED's attributes
 * would leak). PUBLIC is open; the viewer's own posts are always allowed;
 * FOLLOWERS_ONLY requires the viewer to follow the author; everything else is
 * denied.
 *
 * NOTE: block / restrict relationships are not resolved onto the feed engine
 * context pre-hydration, so this enforces post VISIBILITY only.
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
 * Returns `null` when a `postId` was given but is not found, or when the viewer
 * is not authorized to view that seed post.
 *
 * The Mongo original guarded the lookup with `ObjectId.isValid`. That guard is
 * DELETED per `@oxyhq/db`: it existed only to dodge a `CastError`, and a text id
 * naming no row already produces the `null` this returns.
 */
async function resolveSeed(
  params: Record<string, unknown>,
  ctx: FeedEngineContext,
): Promise<MoreLikeThisSeed | null> {
  const postId = typeof params.postId === 'string' ? params.postId : '';

  if (postId) {
    let seedPost:
      | { topics: string[] | null; hashtags: string[] | null; oxyUserId: string | null; visibility: string }
      | undefined;
    try {
      [seedPost] = await getDb()
        .select({
          topics: posts.classificationTopics,
          hashtags: posts.hashtags,
          oxyUserId: posts.oxyUserId,
          visibility: posts.visibility,
        })
        .from(posts)
        .where(eq(posts.id, postId))
        .limit(1);
    } catch (error) {
      logger.warn('[moreLikeThis source] Failed to load seed post', { postId, error });
      return null;
    }
    if (!seedPost) return null;
    const authorId = seedPost.oxyUserId ?? '';
    if (!isSeedAuthorized(seedPost.visibility, authorId, ctx)) return null;
    return {
      topics: normalizeTerms(seedPost.topics, MAX_SEED_TERMS),
      hashtags: normalizeTerms(seedPost.hashtags, MAX_SEED_TERMS),
      authorId,
      excludeId: postId,
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

    const alternatives: SQL[] = [];
    if (seed.topics.length > 0) {
      alternatives.push(arrayOverlaps(posts.classificationTopics, seed.topics));
    }
    if (seed.hashtags.length > 0) {
      alternatives.push(arrayOverlaps(posts.hashtags, seed.hashtags));
    }
    if (seed.authorId) alternatives.push(eq(posts.oxyUserId, seed.authorId));

    const windowStart = new Date(Date.now() - MtnConfig.feed.candidateSources.recencyWindowMs);
    const conditions: SQL[] = [
      eq(posts.visibility, PostVisibility.PUBLIC),
      eq(posts.status, 'published'),
      gte(posts.createdAt, windowStart),
      discoverySafeSql(),
      or(...alternatives) as SQL,
      notABoostSql(),
    ];
    if (seed.excludeId) conditions.push(ne(posts.id, seed.excludeId));

    const poolSize = Math.min(cap * MORE_LIKE_THIS_POOL_MULTIPLIER, MORE_LIKE_THIS_MAX_POOL);
    const db = getDb();
    const rows = await db
      .select()
      .from(posts)
      .where(and(...conditions))
      .orderBy(...chronoOrderBy())
      .limit(poolSize);
    const candidates: CandidatePost[] = await assemblePostRecords(rows, db);

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

/** Metres per kilometre — PostGIS geography distances are in metres. */
const METRES_PER_KM = 1000;

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
 * {@link NEARBY_MAX_RADIUS_KM}), ordered by ascending distance.
 *
 * ## The PostGIS port of `$near`
 *
 * `$near` did two things at once — bound the radius AND order by distance — so
 * both are stated explicitly here:
 *
 *  - `ST_DWithin(geo, point, metres)` is the radius bound. It is the
 *    index-usable spelling; `ST_Distance(...) <= metres` computes a distance for
 *    every row in the table and cannot use the GiST index.
 *  - `geo <-> point` is the KNN distance operator, also GiST-accelerated, and is
 *    what makes the ordering "nearest first" rather than an unordered set.
 *
 * `posts.geo` is `GENERATED ALWAYS AS ST_MakePoint(longitude, latitude)` — note
 * LONGITUDE FIRST, which is also the argument order used here. A transposed pair
 * yields a plausible point in the wrong hemisphere rather than an error, so the
 * test for this asserts an independently checkable real-world distance rather
 * than merely that a row came back.
 *
 * DATA CAVEAT: post coordinates are SPARSE (only posts that explicitly attach a
 * creation location carry them), so the geo path can return little. When no
 * coordinates are given (or they are out of range) the source falls back to the
 * viewer's learned region match — a coarse "content from your region"
 * approximation that keeps the feed non-empty. Returns `[]` when neither is
 * available.
 */
export const nearbySource: SourceModule = {
  id: 'nearby',
  kind: 'source',
  userComposable: true,
  gather: async (ctx, params, cap) => {
    const lat = toFiniteNumber(params.lat);
    const lng = toFiniteNumber(params.lng);
    const db = getDb();

    if (lat !== null && lng !== null && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) {
      const radiusKm = clamp(
        toFiniteNumber(params.radiusKm) ?? NEARBY_DEFAULT_RADIUS_KM,
        1,
        NEARBY_MAX_RADIUS_KM,
      );
      const point = sql`ST_MakePoint(${lng}, ${lat})::geography`;

      const rows = await db
        .select()
        .from(posts)
        .where(
          and(
            eq(posts.visibility, PostVisibility.PUBLIC),
            eq(posts.status, 'published'),
            discoverySafeSql(),
            notABoostSql(),
            sql`ST_DWithin(${posts.geo}, ${point}, ${radiusKm * METRES_PER_KM})`,
          ),
        )
        .orderBy(sql`${posts.geo} <-> ${point}`)
        .limit(cap);
      return assemblePostRecords(rows, db);
    }

    const region =
      typeof ctx.viewerRegion === 'string' && ctx.viewerRegion.trim() ? ctx.viewerRegion : '';
    if (!region) return [];

    const keyset = await chronoCursorSql(ctx.cursor);
    const conditions: SQL[] = [
      eq(posts.classificationRegion, region),
      eq(posts.visibility, PostVisibility.PUBLIC),
      eq(posts.status, 'published'),
      discoverySafeSql(),
    ];
    if (keyset) conditions.push(keyset);

    const rows = await db
      .select()
      .from(posts)
      .where(and(...conditions))
      .orderBy(...chronoOrderBy())
      .limit(cap);
    return assemblePostRecords(rows, db);
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

/**
 * How long a computed ranking is reused, DERIVED from the sampling cadence
 * rather than chosen.
 *
 * `followerSnapshotJob` appends a sample every `FOLLOWER_SNAPSHOT_INTERVAL_MS`,
 * and the ranking is a function of those samples alone — so it CANNOT change
 * more often than that, and a shorter TTL would buy nothing but a repeat of the
 * aggregation below. Importing the constant instead of restating it is what
 * keeps the two from drifting: retune the sampling cadence and this follows.
 */
const RISING_CREATORS_CACHE_TTL_MS = FOLLOWER_SNAPSHOT_INTERVAL_MS;

/** One author's follower growth over the window, as the ranking sees it. */
interface RankedCreator {
  id: string;
  delta: number;
  rate: number;
}

/**
 * The ranking, memoized in process.
 *
 * ## What this is worth
 *
 * The aggregation below has NO `LIMIT` and cannot have one: every author's first
 * and last sample in the window is needed before any of them can be ranked.
 * Measured against a production-shaped corpus (2,000,000 snapshots over the real
 * 30-day retention, 12,000 authors, ~466k rows inside the 7-day window):
 *
 * ```
 *   GroupAggregate over 466,260 rows -> 12,000 groups
 *   Sort Method: external merge  Disk: 19176kB
 *   Buffers: shared hit=200,431  temp read=2,397 written=2,398
 *   Execution Time: ~1,450 ms
 * ```
 *
 * Uncached, that was the cost of EVERY `gather`. `risingCreators` is
 * `userComposable` and sits in no preset feed, so it only runs when someone
 * composes a custom feed with it — but nothing stopped one person refreshing
 * such a feed from holding ~1.4 s of sort and 19 MB of temp I/O continuously.
 *
 * ## Deliberately in process, and deliberately without a timer
 *
 * Same reasoning as `services/trending/storyIndex.ts`: the value is small,
 * derived and read-only, and any task can rebuild it from one query — so a
 * shared cache would buy a consistency nobody can observe, at the cost of a
 * round trip and a second failure mode. A module-level `setInterval` would hold
 * the event loop open (see AGENTS.md); a lazy check on read costs nothing when
 * nobody is reading.
 *
 * ## A FAILURE IS NEVER MEMOIZED, which is where this parts company with
 * `storyIndex`
 *
 * That module caches its empty answer so a database in trouble is not retried on
 * every request — sound at a 5-minute TTL. At SIX HOURS it would turn one
 * transient error into a source that returns nothing until tomorrow. The soft
 * failure below therefore returns `[]` without storing it, so the next `gather`
 * tries again.
 */
let rankedCreatorsCache: { ranked: RankedCreator[]; expiresAt: number } | null = null;

/**
 * The refresh in flight, so N concurrent cold `gather`s run ONE aggregation
 * rather than N. Without it the first request after a restart is the worst case
 * this cache exists to remove, multiplied by however many arrive together.
 */
let rankedCreatorsInFlight: Promise<RankedCreator[]> | null = null;

/** Drop the memo. Tests only — production refreshes on its own. */
export function resetRisingCreatorsCache(): void {
  rankedCreatorsCache = null;
  rankedCreatorsInFlight = null;
}

/**
 * Aggregate every author's follower delta over the window and rank by growth
 * RATE. Soft-fails to `[]`.
 *
 * The window is the one the CALLER computed, so a refresh always measures the
 * seven days ending now. Between refreshes the answer is frozen with it, which
 * is the trade the TTL states: the window slides six hours out of a hundred and
 * sixty-eight, and nothing inside it can have changed anyway.
 */
async function refreshRankedCreators(windowStart: Date, now: number): Promise<RankedCreator[]> {
  let groups: Array<{ oxyUserId: string; first: number; last: number }>;
  try {
    groups = await getDb()
      .select({
        oxyUserId: authorFollowerSnapshots.oxyUserId,
        first: sql<number>`(array_agg(${authorFollowerSnapshots.followerCount} order by ${authorFollowerSnapshots.at} asc))[1]`,
        last: sql<number>`(array_agg(${authorFollowerSnapshots.followerCount} order by ${authorFollowerSnapshots.at} desc))[1]`,
      })
      .from(authorFollowerSnapshots)
      .where(gte(authorFollowerSnapshots.at, windowStart))
      .groupBy(authorFollowerSnapshots.oxyUserId);
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
        id: group.oxyUserId,
        delta,
        rate: delta / Math.max(first, RISING_FOLLOWER_SMOOTHING),
      };
    })
    .filter((group) => group.id.length > 0 && group.delta > 0)
    .sort((a, b) => b.rate - a.rate)
    .slice(0, RISING_CREATORS_MAX_AUTHORS);

  rankedCreatorsCache = { ranked, expiresAt: now + RISING_CREATORS_CACHE_TTL_MS };
  return ranked;
}

/** The ranking: from the memo when it is live, otherwise one shared refresh. */
function loadRankedCreators(windowStart: Date, now: number): Promise<RankedCreator[]> {
  if (rankedCreatorsCache && rankedCreatorsCache.expiresAt > now) {
    return Promise.resolve(rankedCreatorsCache.ranked);
  }
  if (!rankedCreatorsInFlight) {
    const pending = refreshRankedCreators(windowStart, now);
    rankedCreatorsInFlight = pending;
    void pending.finally(() => {
      if (rankedCreatorsInFlight === pending) rankedCreatorsInFlight = null;
    });
  }
  return rankedCreatorsInFlight;
}

/**
 * `risingCreators`: creators gaining followers fastest right now.
 *
 * Reads `author_follower_snapshots` (populated by the leader-gated
 * `followerSnapshotJob`), computes each author's follower-growth delta over the
 * window (last − first snapshot), ranks by growth RATE (smoothed so up-and-comers
 * beat already-huge accounts), and returns those authors' recent public SFW
 * top-level posts, scored (`finalScore`) by their author's growth rate.
 *
 * `$first`/`$last` after a `$sort` become `array_agg(... ORDER BY ...)` picking
 * element 1 — the aggregate carries its own ordering, so unlike the Mongo
 * pipeline this does not depend on a preceding sort stage that a later edit
 * could remove.
 *
 * INFRA CAVEAT: inert until the snapshot job has recorded at least two samples
 * spanning the window for some authors — with no snapshots (or no positive
 * growth) it soft-fails to `[]`.
 */
export const risingCreatorsSource: SourceModule = {
  id: 'risingCreators',
  kind: 'source',
  userComposable: true,
  gather: async (_ctx, _params, cap) => {
    const now = Date.now();
    const windowStart = new Date(now - RISING_CREATORS_WINDOW_MS);
    const db = getDb();

    // The RANKING is memoized; the posts query below is not, and that split is
    // the point. Which authors are rising cannot change between snapshot sweeps,
    // but which posts they have just published changes constantly — so a reader
    // refreshing a custom feed still sees new posts, from a ranking that is at
    // most one sampling interval old.
    const ranked = await loadRankedCreators(windowStart, now);
    if (ranked.length === 0) return [];

    const rateById = new Map(ranked.map((group) => [group.id, group.rate]));
    const authorIds = ranked.map((group) => group.id);

    const poolSize = Math.min(cap * RISING_CREATORS_POST_MULTIPLIER, MORE_LIKE_THIS_MAX_POOL);
    const rows = await db
      .select()
      .from(posts)
      .where(
        and(
          isNotNull(posts.oxyUserId),
          // `inArray`, never `= any(${authorIds})`: a raw JS array interpolated
          // into `sql` binds as a ROW CONSTRUCTOR (`($1, $2)`), and Postgres
          // rejects it with `op ANY/ALL (array) requires array on right side`.
          // This one shipped here and was caught by `feedPredicates.test.ts`
          // hitting the identical mistake in its own fixture helper.
          inArray(posts.oxyUserId, authorIds),
          eq(posts.visibility, PostVisibility.PUBLIC),
          eq(posts.status, 'published'),
          gte(posts.createdAt, windowStart),
          discoverySafeSql(),
          eq(posts.isReply, false),
          notABoostSql(),
        ),
      )
      .orderBy(...chronoOrderBy())
      .limit(poolSize);
    const candidates: CandidatePost[] = await assemblePostRecords(rows, db);

    return candidates
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
