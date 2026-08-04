/**
 * Discovery / media source modules — the Videos, Media, Explore candidate
 * queries and the anonymous/never-blank "popular" fallbacks. Each reproduces the
 * pre-existing feed's exact predicate + ranking; the engine adds the
 * ranking/slicing/pagination wrapper.
 *
 * Internal (not user-composable): they mirror bespoke preset feeds.
 */

import { MtnConfig } from '@mention/shared-types';
import {
  and,
  arrayOverlaps,
  desc,
  eq,
  getTableColumns,
  gte,
  lt,
  lte,
  notInArray,
  sql,
  type SQL,
} from 'drizzle-orm';
import { getDb } from '../../../../db/postgres';
import { posts } from '../../../../db/schema';
import { assemblePostRecords } from '../../../../db/posts/postRepository';
import { FeedQueryBuilder, authorNotInSql, notABoostSql, rankingWeight } from '../../../../utils/feedQueryBuilder';
import { fetchWithRecencyFallback } from '../../../../utils/feedUtils';
import { ScoreCursor, chronoOrderBy, type ScoreCursorData } from '../../CursorBuilder';
import { discoverySafeSql, filterDiscoverable } from '../../feedSafety';
import type { CandidatePost, FeedEngineContext, SourceModule } from '../types';

/**
 * WHERE THE `maxTimeMS(5000)` WENT — a deliberate relocation, not a dropped
 * guard.
 *
 * Every Mongo source capped itself with `.maxTimeMS(5000)` because the driver
 * offers no other place to put it. Postgres does: `statement_timeout` is a
 * server GUC settable per ROLE or per DATABASE, which is the correct home for a
 * blanket "no query may run longer than N" rule — it covers every query
 * including the ones nobody remembered to annotate, and it cannot drift from a
 * constant copied into thirty call sites.
 *
 * Reproducing it per-query here would mean wrapping each scan in
 * `BEGIN; SET LOCAL statement_timeout …; …; COMMIT;` — two extra round trips on
 * a path that issues eight source queries in parallel per feed page — to buy
 * exactly what one `ALTER ROLE … SET statement_timeout` buys for free.
 *
 * So this is an explicit HANDOFF, and it is listed in the migration report:
 * until the application role carries a `statement_timeout`, these scans are
 * unbounded. That is a real gap; it belongs to whoever provisions the role,
 * not to the query layer.
 */

/**
 * The standard engagement composite used by the popular / explore / trending
 * aggregations, as a SQL expression. THE single source of truth for the
 * composite so the discovery lanes can never drift.
 *
 * The boost term splits the total boosts into their native and federated subsets
 * (`stats_federated_boosts_count` counts inbound ActivityPub Announces): the
 * native subset — `greatest(0, boosts − federatedBoosts)`, floored so an
 * over-count can never go negative — is weighted at `boostWeight`, and the
 * federated subset at the deliberately-lower `federatedBoostWeight`.
 *
 * Two things the Mongo original needed and this does not:
 *
 *  - `$ifNull` on every term. All four columns are `NOT NULL DEFAULT 0`, so a
 *    null is unrepresentable rather than merely unlikely — the pre-backfill
 *    documents those wrappers existed for cannot occur.
 *  - Nothing guarded the RESULT TYPE, because Mongo had one number type.
 *    Postgres does not: the weights are decimal literals, `integer * numeric` is
 *    `numeric`, and postgres.js returns `numeric` as a **string** to preserve
 *    precision. That string then flows into `finalScore`, sorts lexicographically
 *    in any JS comparison, and serializes into the cursor as a quoted value. The
 *    explicit `::double precision` is what keeps the score a NUMBER end to end.
 */
export function engagementScoreSql(): SQL<number> {
  const cfg = MtnConfig.ranking.engagement;
  return sql<number>`(
    ${posts.statsLikesCount} * ${rankingWeight(cfg.likeWeight)}
    + greatest(0, ${posts.statsBoostsCount} - ${posts.statsFederatedBoostsCount}) * ${rankingWeight(cfg.boostWeight)}
    + ${posts.statsFederatedBoostsCount} * ${rankingWeight(cfg.federatedBoostWeight)}
    + ${posts.statsCommentsCount} * ${rankingWeight(cfg.commentWeight)}
  )::double precision`;
}

/**
 * WHY NEITHER OF THE TWO SOURCES BELOW APPLIES THE CURSOR — the question this
 * file will be asked again.
 *
 * `videos` and `media` are RANKED sources, not pre-scored ones and not
 * chronological ones. They hand the engine an unordered candidate POOL; the
 * engine scores it in process (`FeedRankingService.rankPosts`) and paginates the
 * RESULT by a score window (`FeedEngine.finalizeRanked`). Nothing about their
 * output is ordered by id, so an id bound here narrows the pool on an axis
 * neither layer sorts by: a post that scored just BELOW the cursor — exactly the
 * page-two candidate the score window is there to admit — is dropped before
 * ranking ever sees it, and since the bound only ever moves down it can never
 * come back in that session.
 *
 * Nothing is lost by dropping it. Forward progress is the SCORE window's job and
 * it needs no help: every item on the emitted page scores at or above that
 * page's cursor anchor, so the window excludes the whole page by construction.
 * The seen set (`ctx.seenPostIds`, threaded into the predicate below) is what
 * slides the candidate window forward so the pool keeps refilling.
 */

/** Run a candidate scan under the discovery statement timeout. */
async function selectCandidates(
  where: SQL,
  orderBy: SQL[],
  limit: number,
): Promise<CandidatePost[]> {
  const db = getDb();
  const rows = await db
    .select()
    .from(posts)
    .where(where)
    .orderBy(...orderBy)
    .limit(limit);
  return assemblePostRecords(rows, db);
}

/** `videos`: ranked candidate query for video posts (wraps `buildVideosQuery`). */
export const videosSource: SourceModule = {
  id: 'videos',
  kind: 'source',
  userComposable: false,
  gather: async (ctx, _params, cap) =>
    selectCandidates(
      and(
        FeedQueryBuilder.buildVideosQuery(ctx.seenPostIds ?? [], {
          orientation: ctx.videoFilters?.orientation,
          minDurationSec: ctx.videoFilters?.minDurationSec,
        }),
        discoverySafeSql(),
      ) as SQL,
      chronoOrderBy(),
      cap,
    ),
};

/** `media`: ranked candidate query for media posts (wraps `buildMediaFeedQuery`). */
export const mediaSource: SourceModule = {
  id: 'media',
  kind: 'source',
  userComposable: false,
  gather: async (ctx, _params, cap) =>
    selectCandidates(
      and(
        FeedQueryBuilder.buildMediaFeedQuery(ctx.seenPostIds ?? []),
        discoverySafeSql(),
      ) as SQL,
      chronoOrderBy(),
      cap,
    ),
};

/**
 * Build the bounded RELEVANCE multiplier for the authenticated Explore feed from
 * the viewer's learned signals — a SOFT lift on top of engagement×recency (never
 * a filter). Neutral `1` for anonymous / no-signal viewers.
 *
 * Each matched dimension multiplies in and the product is clamped to `maxBoost`,
 * so no single viewer signal can dominate ranking.
 */
function resolveExploreRelevance(ctx: FeedEngineContext): SQL {
  const cfg = MtnConfig.ranking.exploreRelevance;
  const candidateCfg = MtnConfig.feed.candidateSources;
  const NEUTRAL = sql`1::double precision`;

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

  const factors: SQL[] = [];

  // `arrayOverlaps` is array OVERLAP (`&&`), the direct analogue of Mongo's
  // `$setIntersection(...) > 0`. It goes through drizzle's OPERATOR rather than a
  // hand-written `${topics}::text[]`, because a bare JS array interpolated into a
  // `sql` template is bound as one untyped parameter and postgres.js stringifies
  // it to `tech,news` — which Postgres rejects with `malformed array literal`.
  // The operator maps the value through the COLUMN, which knows to emit
  // `{"tech","news"}`.
  //
  // `coalesce(…, false)` is required because both classification arrays are
  // NULLABLE and `NULL && ARRAY[…]` is NULL: without it the CASE falls to its
  // ELSE for every unclassified post, which happens to be the same neutral `1` —
  // but it would silently become a row-dropping bug the moment this expression is
  // reused in a WHERE rather than a CASE.
  //
  // Every multiplier goes through `rankingWeight` for the reason given there: a
  // bare `${1.25}` next to the integer literal `1` in the same CASE is resolved
  // as `integer` and Postgres rejects the value at execution time.
  if (topics.length > 0) {
    factors.push(sql`(case when coalesce(${arrayOverlaps(posts.classificationTopics, topics)}, false)
      then ${rankingWeight(cfg.topicMatch)} else 1 end)`);
  }

  if (languages.length > 0) {
    factors.push(sql`(case when coalesce(${arrayOverlaps(posts.classificationLanguages, languages)}, false)
      then ${rankingWeight(cfg.languageMatch)} else 1 end)`);
  }

  if (region) {
    factors.push(sql`(case when ${posts.classificationRegion} = ${region}
      then ${rankingWeight(cfg.regionMatch)} else 1 end)`);
  }

  const product = sql.join(factors, sql` * `);
  return sql`least(${rankingWeight(cfg.maxBoost)}, (${product}))::double precision`;
}

/**
 * The Explore score: `(1 + ln(1 + engagement)) × 0.5^(ageHours/halfLife) × relevance`.
 *
 * Returned as ONE `SQL` value that the caller uses in the SELECT, the keyset
 * WHERE and the ORDER BY alike. Postgres cannot reference a select alias from
 * WHERE, and the two obvious ways around that are both worse: repeating the
 * expression by hand invites the copies to drift, and wrapping every query in a
 * derived table to expose the alias buries the predicate a reader needs to see.
 * Reusing one JS value makes drift unrepresentable.
 *
 * `now.toISOString()` rather than `now`, and the trailing cast does NOT make the
 * raw form safe: a JS `Date` interpolated into a `sql` template reaches
 * postgres.js as an unmapped value and throws
 * `TypeError: The "string" argument must be of type string … Received an
 * instance of Date` before a byte is sent. Drizzle's own comparison operators
 * (`lt`, `gte`, …) map a Date through the COLUMN and are unaffected — it is only
 * a hand-written template that has to spell the conversion out.
 */
function exploreFinalScoreSql(now: Date, relevance: SQL): SQL<number> {
  const halfLifeHours = MtnConfig.ranking.recency.halfLifeMs / (1000 * 60 * 60);
  const ageHours = sql`(extract(epoch from (${now.toISOString()}::timestamptz - ${posts.createdAt})) / 3600.0)`;
  const recencyDecay = sql`power(0.5, ${ageHours} / ${halfLifeHours})`;
  const engagementBase = sql`(1 + ln(1 + ${engagementScoreSql()}))`;
  return sql<number>`(${engagementBase} * ${recencyDecay} * ${relevance})::double precision`;
}

/**
 * `explore`: pre-scored discovery aggregation (engagement×recency×relevance) of
 * non-followed public SFW content. Returns candidates decorated with a
 * `finalScore` and sorted, with the score cursor already applied — the engine's
 * pre-scored ranked path slices/diversifies/paginates it.
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

    const rankingCeiling = new Date(rankingAsOf);
    const trendingCutoff = new Date(rankingAsOf - MtnConfig.feed.trendingWindowMs);

    const conditions: SQL[] = [
      eq(posts.visibility, 'public'),
      eq(posts.status, 'published'),
      // Freeze both ends of the candidate window for the whole cursor session:
      // advancing the wall clock or publishing a new post cannot move existing
      // candidates across a page boundary.
      gte(posts.createdAt, trendingCutoff),
      lte(posts.createdAt, rankingCeiling),
      discoverySafeSql(),
      eq(posts.isReply, false),
      notABoostSql(),
    ];

    // `authorNotInSql` rather than a bare `notInArray`, because the author column
    // is nullable and `NOT IN` is NULL-propagating — see its own doc. It also
    // uses `notInArray` internally rather than `<> all(${array})`: a raw JS array
    // interpolated into `sql` binds as a ROW constructor, and Postgres then
    // raises "op ANY/ALL (array) requires array on right side".
    const excludeAuthors = authorNotInSql(excludeUserIds);
    if (excludeAuthors) conditions.push(excludeAuthors);

    const cursorExcludedIds = parsedCursor?.excludeIds ?? [];
    if (cursorExcludedIds.length > 0) {
      conditions.push(notInArray(posts.id, [...cursorExcludedIds]));
    }

    const finalScore = exploreFinalScoreSql(rankingCeiling, resolveExploreRelevance(ctx));

    if (parsedCursor && parsedCursor.score !== Infinity && Number.isFinite(parsedCursor.score)) {
      const { score, id } = parsedCursor;
      conditions.push(
        sql`(${finalScore} < ${score} or (${finalScore} = ${score} and ${posts.id} < ${id}))`,
      );
    }

    const db = getDb();
    const rows = await db
      .select({ ...getTableColumns(posts), finalScore })
      .from(posts)
      .where(and(...conditions))
      .orderBy(desc(finalScore), desc(posts.id))
      .limit(cap + 1);

    const candidates: CandidatePost[] = await assemblePostRecords(rows, db);
    return candidates.map((candidate, index) => {
      candidate.finalScore = rows[index].finalScore;
      return candidate;
    });
  },
};

/**
 * `popular`: For You anonymous + never-blank fallback — engagement-sorted recent
 * public thread-root posts, SFW for safe-for-work viewers.
 *
 * This is the WHOLE feed for an anonymous For You viewer (`FeedEngine.run` serves
 * it directly when there is no `currentUserId`) and the never-blank tail for an
 * authenticated one, so it answers to the same editorial rule as the ranked lanes:
 * roots only. It stated that rule by omission — it hand-built its match and simply
 * never asked the question — which is why a signed-out reader of For You saw a
 * pool that was 47.1% replies while the ranked path did not. It now reads the same
 * stored `is_reply` column the `explore` source above it does, so the two
 * discovery surfaces in this file cannot drift on what a reply is.
 */
export const popularSource: SourceModule = {
  id: 'popular',
  kind: 'source',
  userComposable: false,
  gather: async (ctx, _params, cap) => {
    const baseConditions: SQL[] = [
      eq(posts.visibility, 'public'),
      eq(posts.status, 'published'),
      discoverySafeSql(),
      eq(posts.isReply, false),
      notABoostSql(),
    ];

    // Exclude what the viewer has already been shown. The video and media
    // fallbacks thread the seen set through their query builders; this one built
    // its match by hand and never did, so the FIRST fallback page could re-serve
    // exactly the posts the ranked pages had just run out of — the most visible
    // moment to repeat yourself. Later pages were already fine, because the
    // keyset carries the boundary forward; it is only the ranked→fallback
    // transition, where there is no keyset yet, that had nothing to exclude on.
    const seenPostIds = ctx.seenPostIds ?? [];
    if (seenPostIds.length > 0) {
      baseConditions.push(notInArray(posts.id, [...seenPostIds]));
    }

    // This source is BOTH For You anonymous and the authenticated never-blank
    // fallback, so it is handed whatever cursor the ranked feed last emitted —
    // including a `ScoreCursor`, which is not a bare id.
    const parsedCursor = ScoreCursor.parse(ctx.cursor);
    if (parsedCursor?.excludeIds?.length) {
      baseConditions.push(notInArray(posts.id, [...parsedCursor.excludeIds]));
    }

    const engagementScore = engagementScoreSql();
    const keyset = popularKeysetSql(engagementScore, parsedCursor);
    if (keyset) baseConditions.push(keyset);

    // A recency window bounds the engagement scan; the never-blank fallback
    // widens (7d → 30d → unbounded) so this source is never starved on a
    // low-traffic instance.
    const candidates = await fetchWithRecencyFallback(cap, async (cutoff) => {
      const conditions = cutoff
        ? [...baseConditions, gte(posts.createdAt, cutoff)]
        : baseConditions;
      return runPopular(and(...conditions) as SQL, engagementScore, cap);
    });

    return filterDiscoverable(candidates);
  },
};

/**
 * The sort every popular source orders by, and therefore the keyset it must page
 * on.
 *
 * THREE keys, where `explore` needs two: `engagementScore` carries no recency
 * term, so every zero-engagement post ties on it and `created_at` is doing real
 * ordering work rather than breaking rare ties. Ordering that bulk by id instead
 * would be meaningless — see {@link chronoOrderBy} on why `posts.id` is not a time
 * order in this schema.
 */
function popularOrder(engagementScore: SQL<number>): SQL[] {
  return [desc(engagementScore), desc(posts.createdAt), desc(posts.id)];
}

/** Run one popular scan, stamping the engagement score each candidate sorted on. */
async function runPopular(where: SQL, engagementScore: SQL<number>, cap: number): Promise<CandidatePost[]> {
  const db = getDb();
  const rows = await db
    .select({ ...getTableColumns(posts), engagementScore })
    .from(posts)
    .where(where)
    .orderBy(...popularOrder(engagementScore))
    .limit(cap);

  const candidates: CandidatePost[] = await assemblePostRecords(rows, db);
  return candidates.map((candidate, index) => {
    candidate.engagementScore = rows[index].engagementScore;
    return candidate;
  });
}

/**
 * The keyset predicate continuing a popular page, matching {@link popularOrder}.
 *
 * Returns `undefined` unless the cursor is one THIS regime minted and it can
 * express the full key. Two independent requirements, both necessary:
 *
 *  - PROVENANCE (`fromPopularFallback`). `parsed.score` becomes a bound on the
 *    engagement score here, so a cursor whose score is a ranking `finalScore` —
 *    which a `neverBlank` feed hands over the moment its ranked pool empties —
 *    would compare two different quantities.
 *  - COMPLETENESS (`tiebreakAt`). A legacy cursor, or a v1 cursor minted before
 *    `tiebreakAt` existed, cannot say which `created_at` the page stopped at,
 *    and a keyset needs a value for every key it orders on.
 *
 * Failing either, the caller relies on the cursor's bounded `excludeIds` for
 * that single page instead of filtering on an axis it is not sorted by —
 * precisely the defect this replaces: an id filter under an engagement sort both
 * repeats high-engagement posts and permanently skips newer, less-engaged ones.
 *
 * The two `created_at` comparisons go through drizzle's OPERATORS rather than
 * being written into the template as `${boundaryAt}`. A JS `Date` interpolated
 * into a `sql` template reaches postgres.js unmapped and throws
 * `TypeError: The "string" argument must be of type string … Received an
 * instance of Date` — client-side, before anything is sent, so no cast can save
 * it. `lt`/`eq` map the Date through the column that knows its type. This is a
 * page-TWO-only path, which is why a shape assertion never saw it: page one
 * builds no keyset at all.
 */
function popularKeysetSql(engagementScore: SQL<number>, parsed?: ScoreCursorData): SQL | undefined {
  if (!parsed || !parsed.fromPopularFallback) return undefined;
  if (!Number.isFinite(parsed.score) || parsed.tiebreakAt === undefined) return undefined;
  if (!parsed.id) return undefined;

  const boundaryAt = new Date(parsed.tiebreakAt);
  return sql`(
    ${engagementScore} < ${parsed.score}
    or (${engagementScore} = ${parsed.score} and ${lt(posts.createdAt, boundaryAt)})
    or (
      ${engagementScore} = ${parsed.score}
      and ${eq(posts.createdAt, boundaryAt)}
      and ${lt(posts.id, parsed.id)}
    )
  )`;
}

/** Shared engagement-sorted popular scan for the media/video fallbacks. */
async function gatherPopularByQuery(
  contentPredicate: SQL,
  cap: number,
  cursor?: string,
): Promise<CandidatePost[]> {
  const parsed = ScoreCursor.parse(cursor);
  const engagementScore = engagementScoreSql();

  const conditions: SQL[] = [contentPredicate];
  if (parsed?.excludeIds?.length) {
    conditions.push(notInArray(posts.id, [...parsed.excludeIds]));
  }
  const keyset = popularKeysetSql(engagementScore, parsed);
  if (keyset) conditions.push(keyset);

  return runPopular(and(...conditions) as SQL, engagementScore, cap);
}

/**
 * `popularVideos`: the Videos fallback.
 *
 * The cursor goes to {@link gatherPopularByQuery}, which keysets on the
 * `{engagementScore, createdAt, id}` axis this source actually sorts by. The
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
      and(
        FeedQueryBuilder.buildVideosQuery(ctx.seenPostIds ?? [], {
          orientation: ctx.videoFilters?.orientation,
          minDurationSec: ctx.videoFilters?.minDurationSec,
        }),
        discoverySafeSql(),
      ) as SQL,
      cap,
      ctx.cursor,
    ),
};

/** `popularMedia`: the Media fallback. Same shape as above. */
export const popularMediaSource: SourceModule = {
  id: 'popularMedia',
  kind: 'source',
  userComposable: false,
  gather: async (ctx, _params, cap) =>
    gatherPopularByQuery(
      and(
        FeedQueryBuilder.buildMediaFeedQuery(ctx.seenPostIds ?? []),
        discoverySafeSql(),
      ) as SQL,
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
