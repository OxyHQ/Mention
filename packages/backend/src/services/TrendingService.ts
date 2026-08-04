import {
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  gte,
  inArray,
  lt,
  lte,
  sql,
  type SQL,
} from 'drizzle-orm';
import { MtnConfig, PostVisibility } from '@mention/shared-types';
import { TopicType } from '@oxyhq/core';
import { getDb } from '../db/postgres';
import {
  TRENDING_RETENTION_SECONDS,
  trendBatches,
  trending,
} from '../db/schema/discovery';
import { postContentVariants } from '../db/schema/postContent';
import { posts } from '../db/schema/posts';
import { TrendingType } from '../db/schema/discovery';
import { logger } from '../utils/logger';
import { getRedisClient } from '../utils/redis';
import { emitTrendsUpdated } from '../utils/socket';
import { aliaChat, isAliaEnabled } from '../utils/alia';
import { topicService } from './TopicService';
import { isNsfwHashtag } from './contentClassification/nsfw';
import { isTopicSlug } from './contentClassification/taxonomy';
import { isTrendStopWord } from './trending/termExtraction';
import { trendCandidateUnionSql, trendTermMatchSql } from './trending/termSpace';
import {
  buildClusterMap,
  clusterTrendTerms,
  type TrendTermPair,
} from './trending/trendClustering';
import {
  buildTrendGraph,
  saveTrendGraph,
  type TrendGraphNodeInput,
  type TrendGraphSnapshot,
} from './trending/trendGraph';
// Trending shares the SINGLE canonical sensitive-exclusion clause with every
// feed (For You, Explore, ranking). Adding a new gate updates trending too.
import { sensitiveExcludeSql } from '../mtn/feed/feedSafety';
import { mintTrendRecId } from './trending/trendTelemetry';
import { buildTrendSeries } from './trending/trendSeries';
import {
  rankTrendCandidates,
  resolveTrendStartedAt,
  topUpWithPopular,
  type ScoredTrend,
  type TrendCandidate,
} from './trending/trendScoring';
import {
  deriveTrendLabel,
  fallbackTrendLabel,
  TREND_LABEL_VERSION,
  type TrendLabel,
} from './trending/trendLabeling';
import { resolveTrendSummary, type TrendSummaryResult } from './trending/trendSummary';
import { metrics } from '../utils/metrics';
import { isFallbackUserSummary, resolveUserSummaries } from './PostHydrationService';
import type { PostUser, TrendCategory, TrendStatus } from '@mention/shared-types';

/**
 * The stored spelling of a trend's kind — the same three strings
 * {@link TrendingType} carries, as the plain literal union the `trending.type`
 * column is typed with.
 *
 * Both spellings exist on purpose. `TrendingType` is a string ENUM and TypeScript
 * treats those nominally, so an enum member is not assignable to `'hashtag'` and
 * vice versa; the enum stays the PUBLIC vocabulary (`routes/trending.routes.ts`
 * validates `?type=` against it) while everything that touches a row uses the
 * column's own type. They are the identical three strings at runtime, which is
 * what makes converting at the boundary a no-op rather than a translation.
 */
type TrendingKind = (typeof trending.$inferSelect)['type'];

/** How many trends one archived day carries in `GET /trending/history`. */
const HISTORY_TRENDS_PER_DAY = 20;

/**
 * How long the current batch's `recId` is memoized in process. Far shorter than
 * the 30-minute batch interval so a rotation is picked up almost immediately,
 * long enough that a burst of reported presses costs at most one database read.
 */
const CURRENT_REC_ID_TTL_MS = 30_000;

/**
 * Posts sampled per term as naming evidence.
 *
 * Twelve, not three: the labeller asks which phrase MOST of the posts share, and
 * a majority of three is two — a coincidence, not a consensus. Twelve is a
 * single indexed lookup with a text-only projection, and it only runs for terms
 * that have no label yet.
 */
const TREND_EXCERPTS_PER_TERM = 12;

interface TrendItem {
  type: TrendingType;
  /** The term (retrieval key). */
  name: string;
  /** Every term the row stands for, `name` first. One element unless merged. */
  terms: string[];
  /** What a reader sees. Never the bare term unless labelling produced nothing better. */
  displayName: string;
  category: TrendCategory;
  description: string;
  score: number;
  burstScore: number;
  volume: number;
  authorCount: number;
  momentum: number;
  startedAt: Date;
  status?: TrendStatus;
  actorIds: string[];
  languages: string[];
  topicId?: string;
}

/**
 * One term as the aggregation measured it: the numbers the scorer needs, plus
 * the two facts only the aggregation can know — who posted it, and whether the
 * term arrived mostly as a hashtag (which is all `type` means now).
 */
interface TermCandidate {
  measurement: TrendCandidate;
  actorIds: string[];
  /** Posts on which the term appeared as a hashtag. Decides `type`, never the score. */
  hashtagVolume: number;
  /**
   * Posts on which the term appeared as a CLASSIFIED topic slug. Gates the topic
   * registry lookup: only a term the classifier itself produced may be resolved
   * there, because `resolveNames` writes through to the shared registry.
   */
  topicVolume: number;
  /** Primary languages of the posts behind the term (ISO 639-1). */
  languages: string[];
  /** Coarse regions of those posts, where known. Frequently empty — the field is sparse. */
  regions: string[];
  /**
   * Every term this row reports, the representative first.
   *
   * One element for a term that stands alone; several when co-occurrence
   * showed `Ukraine`, `Kyiv` and `Zelensky` to be one story. Persisted, because
   * the row's feed has to match all of them: opening `Ukraine` onto posts that
   * only ever said `Kyiv` is the whole point of having merged them.
   */
  members: string[];
}

/** What one aggregation pass produces: the rows to rank, and the graph behind them. */
interface TermCandidateResult {
  candidates: TermCandidate[];
  /** `null` when clustering is disabled — no co-occurrence query ran, so there are no edges. */
  graph: TrendGraphSnapshot | null;
}

/** The four fields the graph needs out of a per-term measurement. */
function graphNodes(candidates: readonly TermCandidate[]): TrendGraphNodeInput[] {
  return candidates.map((candidate) => ({
    term: candidate.measurement.term,
    volume: candidate.measurement.volume,
    authorCount: candidate.measurement.authorCount,
    languages: candidate.languages,
    regions: candidate.regions,
  }));
}

/**
 * Which of the three `TrendingType` values a row gets.
 *
 * Provenance only — how the term was WRITTEN, not how it was scored. It exists
 * because `GET /trending?type=` is a public filter and because a term backed by
 * a real Topic document routes to a topic page. The hashtag test is a majority:
 * a term most of whose posts spelled it with a `#` is a hashtag; a term people
 * mostly just wrote is an entity.
 */
function resolveTrendType(input: {
  hasTopic: boolean;
  topicVolume: number;
  hashtagVolume: number;
  volume: number;
}): TrendingType {
  // A term the CLASSIFIER produced is a topic, whether or not the shared Topic
  // registry resolved a document for it. Those are two different facts and only
  // the first is about what the term IS: registry resolution is a remote call
  // that can return nothing for a slug this instance classifies perfectly well,
  // and gating the type on it filed `politics` as an `entity` on the live list.
  // The registry linkage still rides separately, in `topicId`.
  if (input.hasTopic || input.topicVolume > 0) return TrendingType.TOPIC;
  return input.hashtagVolume * 2 >= input.volume ? TrendingType.HASHTAG : TrendingType.ENTITY;
}

/**
 * How much wider the trend query reaches when a reader's languages have to be
 * matched. Three pages' worth: enough that a reader whose language is a
 * minority here still gets a full list of it, small enough to stay one indexed
 * read.
 */
const LANGUAGE_OVERFETCH = 3;

/**
 * Move the trends a reader can READ to the front, without removing any.
 *
 * A filter would be the obvious thing and is wrong: on a network where one
 * language dominates, filtering leaves speakers of every other language with an
 * empty widget — the failure the never-blank rule exists to prevent, arriving by
 * a different road. Ordering gives a reader their own language first and still
 * shows them what the rest of the network is talking about.
 *
 * A trend with NO recorded language (written before trending measured it, or
 * carried by posts whose language never resolved) is treated as matching: its
 * language is unknown, not foreign, and hiding it would be a claim nobody made.
 *
 * Stable: the incoming order is score order, and terms that match equally keep
 * it.
 */
function orderByLanguageMatch(
  trends: readonly SerializedTrend[],
  languages: readonly string[],
): SerializedTrend[] {
  if (languages.length === 0) return [...trends];

  const wanted = new Set(languages);
  const matches = (trend: SerializedTrend): boolean =>
    !trend.languages?.length || trend.languages.some((language) => wanted.has(language));

  const readable: SerializedTrend[] = [];
  const rest: SerializedTrend[] = [];
  for (const trend of trends) (matches(trend) ? readable : rest).push(trend);
  return [...readable, ...rest];
}

/**
 * The corpus a term could plausibly have appeared in.
 *
 * The sum of the corpora of the languages it WAS written in — not the whole
 * window. A term seen only in Spanish posts is measured against Spanish, so its
 * share means the same thing whether Spanish is most of this network or a
 * tenth of it. That invariance is the entire point: without it the ceiling is
 * strict for the majority language and nearly inert for every other one.
 *
 * A term whose posts carry no resolved language falls back to the whole window,
 * which is the honest denominator when the language is unknown.
 */
function corpusSizeFor(
  languages: readonly string[],
  corpusByLanguage: ReadonlyMap<string | null, number>,
): number {
  let total = 0;
  for (const count of corpusByLanguage.values()) total += count;
  if (languages.length === 0) return total;

  let scoped = 0;
  for (const language of languages) scoped += corpusByLanguage.get(language) ?? 0;
  // A language the corpus count never saw leaves `scoped` at 0; the window
  // total is a safer denominator than dividing by nothing.
  return scoped > 0 ? scoped : total;
}

/**
 * What the database actually accepted for a batch. Returned rather than thrown so
 * a single rejected row degrades one trend instead of the whole batch — see
 * {@link TrendingService.saveTrendingBatch}.
 */
interface TrendingBatchWrite {
  /** Rows the database accepted. */
  insertedCount: number;
  /** Rows it rejected, as `type:name`, so the error log names them. */
  rejected: string[];
}

/**
 * Identity of a ROW within a batch, matching the `{ name, calculatedAt, type }`
 * uniqueness key. Used when naming a row the database refused, so the log points
 * at the exact document.
 *
 * NOT used to key the volume series any more. It could not be: a term is now
 * measured once (the hashtag and topic lanes were merged into one term space),
 * so a name appears at most once per batch, while its `type` is provenance that
 * can legitimately flip between batches as the mix of posts spelling it with a
 * `#` shifts. Keying a series on the pair would cut one continuous history in
 * two at the moment of a flip and drop both halves below the drawing floor.
 */
function trendKey(name: string, type: TrendingKind): string {
  return `${type}:${name}`;
}

/**
 * A trend as `GET /trending` serves it: the stored row plus the recent history of
 * its `volume`, which is what the row's sparkline draws.
 *
 * `series` is OPTIONAL and load-bearing. A trend seen in fewer than
 * `MtnConfig.trending.series.minPoints` batches has too little history to draw,
 * and the honest response is its absence — never a padded or flattened stand-in.
 * History trends (`getTrendingHistory`) never carry one at all; see
 * {@link TrendingService.loadVolumeSeries}.
 */
/**
 * What `GET /trending/summary` answers: how to PRESENT one trend.
 *
 * Named for what it is rather than for the summary alone, because the summary
 * is the optional part — a trend has a name and a category from the moment it
 * is detected, and only earns prose once enough readers open it.
 */
export type TrendDetail = TrendSummaryResult & {
  /** The trend's label, as the batch derived it. Absent when not currently trending. */
  displayName?: string;
  category?: TrendCategory;
};

/**
 * A trend row as `GET /trending` serves it.
 *
 * `_id` survives the port because the client's contract requires it; the value
 * is the same one Mongo held, since the backfill copies `_id` verbatim into the
 * `text` primary key.
 */
export interface SerializedTrend {
  _id: string;
  type: TrendingKind;
  /** The TERM — the retrieval key, and what the `trend|<name>` feed matches on. */
  name: string;
  /** What a reader is shown. Absent on rows written before trends had labels. */
  displayName?: string;
  category?: TrendCategory;
  languages?: string[];
  description: string;
  score: number;
  volume: number;
  authorCount?: number;
  burstScore?: number;
  momentum: number;
  startedAt?: Date;
  status?: TrendStatus;
  actorIds?: string[];
  rank: number;
  topicId?: string;
  calculatedAt: Date;
  updatedAt: Date;
}

/** The one row → wire mapping, shared by the live list and the history archive. */
function serializeTrend(row: typeof trending.$inferSelect): SerializedTrend {
  return {
    _id: row.id,
    type: row.type,
    name: row.name,
    ...(row.displayName === null ? {} : { displayName: row.displayName }),
    ...(row.category === null ? {} : { category: row.category }),
    ...(row.languages === null ? {} : { languages: row.languages }),
    description: row.description,
    score: row.score,
    volume: row.volume,
    ...(row.authorCount === null ? {} : { authorCount: row.authorCount }),
    ...(row.burstScore === null ? {} : { burstScore: row.burstScore }),
    momentum: row.momentum,
    ...(row.startedAt === null ? {} : { startedAt: row.startedAt }),
    ...(row.status === null ? {} : { status: row.status }),
    ...(row.actorIds === null ? {} : { actorIds: row.actorIds }),
    rank: row.rank,
    ...(row.topicId === null ? {} : { topicId: row.topicId }),
    calculatedAt: row.calculatedAt,
    updatedAt: row.updatedAt,
  };
}

export type TrendWithSeries = SerializedTrend & {
  series?: number[];
  /**
   * The stored `actorIds` resolved to renderable users — the faces shown beside
   * the trend.
   *
   * Resolved SERVER-SIDE, on the same cached batch path post authors use, so a
   * trends list costs no per-actor round trip from the client and identity stays
   * on one authority. Absent (rather than empty) when nothing resolved, and ids
   * that resolve to the degraded fallback are dropped: a nameless avatar is
   * worse evidence than no avatar.
   */
  actors?: PostUser[];
};

class TrendingService {
  private calculationInterval: NodeJS.Timeout | null = null;
  /** Memoized current-batch token; see {@link getCurrentRecId}. */
  private currentRecIdCache: { value: string | null; expiresAt: number } | null = null;
  private readonly REDIS_CACHE_TTL = 1800; // 30 minutes in seconds
  // History changes only every 30 minutes (each calculation batch), so a short
  // TTL is safe and makes repeat loads of the Explore "Trending" history tab
  // cache reads instead of re-running the day-grouping aggregation.
  private readonly REDIS_HISTORY_CACHE_TTL = 300; // 5 minutes in seconds
  private readonly CALCULATION_INTERVAL = 1800000; // 30 minutes in milliseconds
  // Manual-cleanup window, DERIVED from the `trending` retention constant so the
  // two bounds can never drift (previously a hardcoded 30 days — more aggressive
  // than the 90-day retention/history window, which silently capped visible
  // history at 30d).
  private readonly CLEANUP_DAYS = TRENDING_RETENTION_SECONDS / (24 * 60 * 60); // 90 days
  // Default `limit` for the public trending list (mirrors the GET /trending
  // route default). Warmed into Redis after each recalculation so the most
  // common request is a cache hit, never a cold aggregate.
  private readonly DEFAULT_TRENDING_LIMIT = 20;
  // History query window, in milliseconds, derived from the table's retention so
  // the window never asks for data the expiry sweep has already reaped.
  private readonly HISTORY_WINDOW_MS = TRENDING_RETENTION_SECONDS * 1000;
  // How old the served batch may get before it is reported as stale. Derived from
  // the calculation cadence rather than fixed, so the two can never drift apart.
  // Three cadences: one missed run is a blip (a leader handover, a slow write),
  // three in a row is the job not landing, which is what went unnoticed for a day.
  private readonly STALE_BATCH_AFTER_MS = this.CALCULATION_INTERVAL * 3;

  /**
   * Initialize the service and start periodic calculations.
   *
   * Leader-gated by design: this is invoked ONLY from `startSchedulers()` in
   * `server.ts`, which `LeaderElection` runs on exactly one backend task. Non-
   * leader tasks never compute trends — they serve reads from the shared
   * `trending` table / Redis cache. Same pattern as every other periodic
   * job (FeedJobScheduler, FollowerSnapshotJob, etc.).
   */
  public initialize(): void {
    this.calculateTrending().catch(error => {
      logger.error('[Trending] Initial calculation failed:', error);
    });

    this.calculationInterval = setInterval(() => {
      this.calculateTrending().catch(error => {
        logger.error('[Trending] Periodic calculation failed:', error);
      });
    }, this.CALCULATION_INTERVAL);
    // Never keep the event loop (or the jest run) alive solely for this timer.
    this.calculationInterval.unref?.();

    logger.info('[Trending] Service initialized with 30-minute calculation interval');
  }

  /**
   * Clean up resources.
   */
  public cleanup(): void {
    if (this.calculationInterval) {
      clearInterval(this.calculationInterval);
      this.calculationInterval = null;
    }
  }

  /**
   * Main calculation: aggregate hashtags + topics from classified post data, then save as a batch.
   *
   * `TrendBatch` is what `getTrending` reads the current timestamp from, so it is
   * created only once the rows it points at exist. The failure this ordering
   * guards against is not hypothetical: a batch write that died partway left the
   * `TrendBatch` uncreated, and the endpoint then served its last complete batch
   * for over a day — HTTP 200, full payload, no external sign anything was wrong.
   * Hence the outcome counter here, and the age gauge in {@link getTrending}: the
   * job failing and the job never running must both be visible from outside.
   */
  public async calculateTrending(): Promise<void> {
    try {
      logger.info('[Trending] Starting trending calculation');

      const calculatedAt = new Date();

      // ONE term space. Hashtags, extracted words and classified topic slugs are
      // all just terms, counted the same way, competing in the same list — see
      // `aggregateTermCandidates`.
      const { candidates, graph } = await this.aggregateTermCandidates(calculatedAt);
      const measurements = candidates.map((candidate) => candidate.measurement);
      // Bursts first; then, only if too few things are genuinely spiking, fill
      // out the list by volume. The top-up relaxes the burst bar and nothing
      // else — every floor still applies — so a quiet network gets a list that
      // says "people are posting about this" instead of an empty widget that
      // reads as broken.
      const ranked = topUpWithPopular(measurements, rankTrendCandidates(measurements));

      const allTrends: TrendItem[] = await this.buildTrendItems(ranked, candidates, calculatedAt);

      const popularityUpdates = allTrends
        .filter((trend) => trend.topicId)
        .map((trend) => ({ topicId: trend.topicId as string, trendingScore: trend.score }));

      // Run AI summary generation, trend persistence, and popularity updates in parallel
      const [summary, write] = await Promise.all([
        // The summary reads the LABELS, not the terms: it is prose for a human,
        // and `orioles, frightclub` describes the index rather than the day.
        this.generateSummary(allTrends.slice(0, 10).map((trend) => trend.displayName)),
        this.saveTrendingBatch(allTrends, calculatedAt),
        saveTrendGraph(graph),
        topicService.updatePopularityFromTrending(popularityUpdates),
      ]);

      // Nothing accepted out of a non-empty batch: publishing the `TrendBatch`
      // would point readers at rows that do not exist and blank the widget, which
      // is strictly worse than continuing to serve the previous batch. An empty
      // INSTANCE (no trends measured at all) is a different thing and still
      // publishes — that is a fact about the data, not a failed write.
      if (allTrends.length > 0 && write.insertedCount === 0) {
        throw new Error(
          `Trending batch ${calculatedAt.toISOString()} inserted 0 of ${allTrends.length} rows`,
        );
      }

      if (write.rejected.length > 0) {
        // Loud on purpose. Every rejected row is a trend the batch measured and
        // failed to store, and the only place that is visible is right here.
        logger.error('[Trending] Batch stored with rejected rows', {
          calculatedAt: calculatedAt.toISOString(),
          inserted: write.insertedCount,
          expected: allTrends.length,
          rejected: write.rejected,
        });
      }
      metrics.incrementCounter('trending_calculation_total', 1, {
        result: write.rejected.length > 0 ? 'partial' : 'success',
      });

      await getDb().insert(trendBatches).values({ calculatedAt, summary });

      logger.info(
        `[Trending] Saved batch: ${allTrends.length} trends from ${candidates.length} candidate terms ` +
          `(${popularityUpdates.length} topic popularities updated)`,
      );

      await this.invalidateCache();

      // Warm the default trending cache immediately after invalidation so the
      // first reader after each recalculation gets a cache hit instead of
      // paying the full aggregate cost (see getTrending). Fail-soft.
      await this.warmDefaultCache();

      // Broadcast a lightweight signal so connected clients refetch trends.
      emitTrendsUpdated(calculatedAt.toISOString());

      await this.cleanupOldTrends();
    } catch (error) {
      metrics.incrementCounter('trending_calculation_total', 1, { result: 'failure' });
      logger.error('[Trending] Error calculating trending:', error);
      throw error;
    }
  }

  /**
   * Measure every candidate term over the trailing window, in ONE pipeline.
   *
   * ## One term space
   *
   * A term is drawn from the union of three fields on the post:
   * `postClassification.trendTerms` (the words the post's own text is about),
   * the canonical `hashtags`, and `postClassification.topics`. They are UNIONED
   * rather than counted in separate lanes because they are three ways of
   * learning the same fact — that this post is about `fifa` — and the previous
   * design's separate hashtag and topic lanes are precisely why the list read as
   * a hashtag ranking: the lane that was cheapest to fill decided the output.
   *
   * The union also makes the corpus work TODAY rather than after a backfill: a
   * post written before term extraction has no `trendTerms`, and still
   * contributes through its hashtags and classified topics.
   *
   * ## What is counted
   *
   * `volume` and `recentVolume` are post counts; `authorCount` is DISTINCT
   * authors, which is the number the reporting floor is applied to. Counting
   * posts alone cannot tell fifty people agreeing from one account posting fifty
   * times, and those are opposite facts.
   *
   * `hashtagVolume` / `topicVolume` are provenance, not ranking: they only
   * decide the row's `type` (and which terms may be looked up in the topic
   * registry). Nothing about the score depends on how the term was written.
   */
  private async aggregateTermCandidates(now: Date): Promise<TermCandidateResult> {
    const { windowMs, recentWindowMs } = MtnConfig.trending.detection;
    const windowStart = new Date(now.getTime() - windowMs);
    const recentStart = new Date(now.getTime() - recentWindowMs);

    // The window predicate, built ONCE and used by the corpus count, both term
    // aggregation passes and the co-occurrence query. A term's SHARE of the
    // corpus is only meaningful if the two were counted the same way — a ratio
    // against a corpus the term was never drawn from measures nothing, and one
    // value passed around is what stops two spellings of "the same match"
    // drifting apart.
    //
    // The spam clause is `is not true`, not `< threshold`. Mongo's
    // `{ $not: { $gte: n } }` MATCHED a post with no spam score at all (an
    // unclassified post), and SQL's `<` would DROP exactly those rows, silently
    // shrinking both the corpus and every term's count. `is not true` is total:
    // NULL and false both pass, which is the Mongo behaviour.
    const windowMatch = and(
      gte(posts.createdAt, windowStart),
      eq(posts.status, 'published'),
      eq(posts.visibility, PostVisibility.PUBLIC),
      // Boosts are an intentionally-empty mirror shape; the original is what
      // carries the terms, and counting both would double one post.
      sql`${posts.boostOf} is null`,
      sensitiveExcludeSql(),
      // The SAME threshold the discovery gate uses — one authority for "this is
      // junk in discovery", rather than a second number here that could drift.
      //
      // Worth being precise about what this does and does not buy: it catches
      // RSS/bridge mirrors and link-only news bots, which is a real class. It did
      // NOT catch the account that topped this instance's list — a
      // `mastodon.social` Person posting real prose with eleven boilerplate
      // hashtags, which scores nowhere near spam. The guard that catches THAT is
      // the concentration ceiling in `clearsFloors`. This clause is the cheap
      // complement, not the fix.
      sql`(${posts.classificationScoreSpam} >= ${MtnConfig.feed.discoveryGate.spamRejectThreshold}) is not true`,
    ) as SQL;

    // Corpus size PER LANGUAGE, not just in total. The share-of-corpus ceiling
    // is only meaningful against the corpus a term could have appeared in: a
    // Spanish function word is common among Spanish posts and rare against a
    // corpus dominated by another language, so a global denominator makes the
    // guard systematically weaker for every minority language — exactly where a
    // hand-written stop-word list is already weakest.
    const corpusByLanguage = await this.countWindowPostsByLanguage(windowMatch);

    // Pass one: every term the authors themselves wrote, counted alone.
    const solo = await this.aggregateTermRows(
      windowMatch,
      recentStart,
      corpusByLanguage,
      trendCandidateUnionSql(),
      new Map(),
    );

    const clustering = MtnConfig.trending.clustering;
    // No graph when clustering is off: the co-occurrence query is the only
    // thing that produces edges, and running it to serve a picture nothing else
    // uses would be paying for a feature that is switched off.
    if (!clustering.enabled || solo.length === 0) return { candidates: solo, graph: null };

    // Pass two, only when co-occurrence actually found a story spread across
    // several names. Re-counting rather than adding the members' volumes up is
    // the whole reason this is a second query: a post saying both `Ukraine` and
    // `Kyiv` is ONE post, and a sum would report it as two — inflating the very
    // number the reporting floors are applied to.
    const pairs = await this.loadTermPairs(
      windowMatch,
      solo.map((candidate) => candidate.measurement.term),
    );
    const { clusters, linkedPairs, refusedForSize } = clusterTrendTerms(
      solo.map((candidate) => ({
        term: candidate.measurement.term,
        volume: candidate.measurement.volume,
      })),
      pairs,
      clustering,
    );
    if (refusedForSize.length > 0) {
      // A refused merge leaves a story split across rows, which on the screen is
      // indistinguishable from clustering never having run. Said out loud, a
      // ceiling that is too tight is visible as itself.
      logger.info('[Trending] Cluster merges declined for size', {
        count: refusedForSize.length,
        pairs: refusedForSize.slice(0, 10),
      });
    }
    if (clusters.length === 0) {
      // Edges but no stories is a real and informative state — it says the
      // network is talking about several separate things — so the graph is
      // still worth keeping.
      return { candidates: solo, graph: buildTrendGraph(now, graphNodes(solo), pairs, [], new Map()) };
    }

    const aliases = buildClusterMap(clusters);
    const membersOf = new Map(clusters.map((cluster) => [cluster.representative, cluster.members]));
    logger.info('[Trending] Merged co-occurring terms into stories', {
      clusters: clusters.length,
      merged: aliases.size,
    });

    const merged = await this.aggregateTermRows(
      windowMatch,
      recentStart,
      corpusByLanguage,
      this.clusteredTermsSql(aliases),
      membersOf,
    );
    // A cluster whose representative failed the floors it passed alone would
    // take its members down with it, so a merge can never LOSE a row: anything
    // pass two dropped is restored from pass one.
    const survived = new Set(merged.map((candidate) => candidate.measurement.term));
    const orphaned = solo.filter(
      (candidate) =>
        !survived.has(candidate.measurement.term) && !aliases.has(candidate.measurement.term),
    );
    return {
      candidates: [...merged, ...orphaned],
      // Built from the SOLO measurements, not the merged ones: an edge's two
      // ratios are `posts` over each endpoint's OWN volume, and a merged row
      // reports the story's volume instead. Reading a cluster total as a term
      // total is how a graph ends up drawing links that do not follow from its
      // own numbers.
      graph: buildTrendGraph(now, graphNodes(solo), pairs, linkedPairs, aliases),
    };
  }
  /**
   * One counting pass over the window, grouped by whatever `termsSql` says a
   * post's terms are.
   *
   * Shared by both passes so clustering cannot introduce a second, subtly
   * different definition of volume, recency, authorship or language — the
   * numbers the floors and the burst statistic are applied to. The only thing
   * that differs between the two calls is what a term IS.
   *
   * `lateral unnest` is Mongo's `$unwind` over the term expression, and the
   * `group by` is its `$group`. `array_agg(distinct …)` gives the
   * distinct-author set; the `count(*) filter` clauses are its `$cond` sums.
   *
   * NULL authors, languages and regions are excluded INSIDE the aggregates
   * rather than by a WHERE clause, because a legacy orphan federated post is a
   * real post that must still count toward `volume` — it simply cannot testify
   * to WHO is posting, and letting it inflate the distinct-author floor would be
   * the one way to walk straight past that floor.
   */
  private async aggregateTermRows(
    windowMatch: SQL,
    recentStart: Date,
    corpusByLanguage: Map<string | null, number>,
    termsSql: SQL,
    membersOf: ReadonlyMap<string, string[]>,
  ): Promise<TermCandidate[]> {
    const { minVolume, maxActors, authorPostCap } = MtnConfig.trending.detection;

    // TWO grouping levels, because volume is per-AUTHOR-capped: a term's volume
    // is assembled from what each author contributed, not from a flat post
    // count. `expanded` is the shared scan both levels read, so the corpus is
    // walked ONCE rather than once per level.
    const rows = await getDb().execute<{
      term: string;
      volume: number;
      recentVolume: number;
      hashtagVolume: number;
      topicVolume: number;
      authorCount: number;
      actorIds: string[] | null;
      languages: string[] | null;
      regions: string[] | null;
    }>(sql`
      with expanded as (
        select
          trend_term.term as term,
          ${posts.oxyUserId} as author,
          ${posts.createdAt} as created_at,
          ${posts.language} as language,
          ${posts.classificationRegion} as region,
          ${posts.hashtags} as hashtags,
          ${posts.classificationTopics} as topics
        from ${posts}
        -- select distinct inside the lateral, not a bare unnest.
        --
        -- The union is a CONCATENATION of arrays, so a post carrying the term
        -- BOTH as a hashtag and as an extracted term unnests twice and is
        -- counted twice — inflating that term's volume, its author set and its
        -- burst score against every term that appears once per post. What a
        -- reader would have seen is a term trending because one post mentioned
        -- it twice. Mongo's $setUnion deduplicated per document and this is
        -- where that property lives now. It is what makes the CLUSTERED
        -- expression safe too: mapping Kyiv onto Ukraine yields the
        -- representative twice for a post that said both, and that one post
        -- must count once against the story.
        join lateral (select distinct unnest(${termsSql}) as term) as trend_term on true
        -- The SAME predicate value the corpus count used, not a copy of it: the
        -- share-of-corpus ratio is only meaningful when numerator and
        -- denominator are drawn from one population, and two spellings of "the
        -- same match" is how they stop being.
        where ${windowMatch}
      ),
      per_author as (
        select
          term,
          author,
          count(*) as posts,
          -- The instant is passed as an ISO string with an explicit cast, not
          -- as a JS Date. db.execute hands a raw template parameter straight
          -- to postgres.js without the column type drizzle's own builder
          -- attaches, and a Date there throws ERR_INVALID_ARG_TYPE at
          -- serialization rather than failing as SQL.
          count(*) filter (where created_at >= ${recentStart.toISOString()}::timestamptz) as recent_posts
        from expanded
        group by term, author
      ),
      capped as (
        select
          term,
          -- Each author counted at most authorPostCap times, so volume
          -- measures how WIDELY a term is being said rather than how much. The
          -- bot that posts twenty contributes two, and the volume floor then
          -- measures breadth without anything having to be identified as a bot.
          sum(least(posts, ${authorPostCap}))::int as volume,
          sum(least(recent_posts, ${authorPostCap}))::int as recent_volume
        from per_author
        group by term
      )
      select
        e.term as "term",
        c.volume as "volume",
        c.recent_volume as "recentVolume",
        -- Provenance is NOT capped: it only decides the row's type, and the
        -- question there is how the term was written, not by how many.
        (count(*) filter (where e.hashtags @> array[e.term]::text[]))::int as "hashtagVolume",
        (count(*) filter (where e.topics @> array[e.term]::text[]))::int as "topicVolume",
        (count(distinct e.author))::int as "authorCount",
        (array_agg(distinct e.author) filter (where e.author is not null))[1:${sql.raw(String(maxActors))}] as "actorIds",
        coalesce(array_agg(distinct e.language) filter (where e.language is not null), array[]::text[]) as "languages",
        coalesce(array_agg(distinct e.region) filter (where e.region is not null), array[]::text[]) as "regions"
      from expanded e
      join capped c on c.term = e.term
      group by e.term, c.volume, c.recent_volume
      -- Cheapest possible narrowing, against the CAPPED volume — the number the
      -- floor is meant to be about.
      having c.volume >= ${minVolume}
    `);

    return rows
      // Blocklisted NSFW/adult terms never trend, whatever their numbers.
      .filter((row) => !isNsfwHashtag(row.term))
      // Stop words are filtered AGAIN here, not only at extraction.
      //
      // Extraction runs once, when a post arrives, so a term stored before a
      // word joined the list keeps counting for as long as the window holds it
      // — `why` and `will` stayed on the live list after the change that was
      // supposed to remove them, and would have kept their place for a day.
      // Filtering at detection makes the list retroactive the moment the batch
      // runs, and makes it impossible for the version of the word list that
      // happened to be deployed when a post arrived to decide what trends now.
      // The extraction-time filter still earns its place: it keeps the stored
      // arrays and their index small. This is the one that decides.
      .filter((row) => !isTrendStopWord(row.term))
      // A term that IS one of our own category names is a shelf label, not a
      // thing on the shelf. `classification_topics` stopped proposing
      // candidates for exactly this reason, but the same words also arrive as
      // hashtags an author typed — `#news` reached the live list with fifteen
      // authors and named a row "News · News" — so the rule belongs on the term
      // itself rather than on one of the fields it can travel in.
      //
      // Not a word list: it is the taxonomy already maintained for labelling,
      // read as a stop-list for candidacy. A category gained or renamed there
      // changes this with it.
      .filter((row) => !isTopicSlug(row.term))
      .map((row) => {
        const languages = row.languages ?? [];
        const corpus = corpusSizeFor(languages, corpusByLanguage);
        return {
          measurement: {
            term: row.term,
            volume: row.volume,
            recentVolume: row.recentVolume,
            authorCount: row.authorCount,
            // Set only when the corpus size is known. Absent means "not
            // measured", which the ceiling treats as passing — losing the guard
            // is the right cost of a failed count, losing the term is not.
            ...(corpus ? { documentFrequency: row.volume / corpus } : {}),
          },
          actorIds: row.actorIds ?? [],
          hashtagVolume: row.hashtagVolume,
          topicVolume: row.topicVolume,
          languages,
          regions: row.regions ?? [],
          // A term that was never merged reports itself, so every downstream
          // reader can treat `members` as the row's term list without first
          // asking whether clustering ran.
          members: membersOf.get(row.term) ?? [row.term],
        };
      });
  }

  /**
   * The candidate terms of a post with every clustered member rewritten to the
   * term its row is reported under.
   *
   * A `CASE` per merged member, applied to each element of the candidate union.
   * Mongo needed a `$setUnion` around the mapped array so that a post saying
   * both `Ukraine` and `Kyiv` did not yield the representative twice and get
   * counted twice against the story; here the `select distinct` inside
   * `aggregateTermRows`'s lateral already carries that property, for this
   * expression and the unmapped one alike — one place, not two.
   *
   * Built with `sql.join` over bound parameters rather than interpolated text:
   * a term is arbitrary user-written content and reaches this function straight
   * from a post's own extracted vocabulary.
   */
  private clusteredTermsSql(aliases: ReadonlyMap<string, string>): SQL {
    const merged = [...aliases.entries()].filter(
      ([member, representative]) => member !== representative,
    );
    if (merged.length === 0) return trendCandidateUnionSql();

    const branches = sql.join(
      merged.map(([member, representative]) => sql`when ${member} then ${representative}`),
      sql` `,
    );
    // `array(select …)` rather than `coalesce(array_agg(…), …)`: it yields an
    // empty array for a post with no candidate terms instead of NULL, which is
    // what the caller's `unnest` needs to produce no rows rather than one.
    return sql`array(
      select case t.term ${branches} else t.term end
      from unnest(${trendCandidateUnionSql()}) as t(term)
    )`;
  }

  /**
   * How many posts each PAIR of candidate terms appears in together.
   *
   * Restricted to terms that already cleared the volume floor, which is what
   * keeps this cheap: the pair count is quadratic in the terms one post carries,
   * and a post carries very few candidate terms once ordinary vocabulary is out
   * of the space. `minPairPosts` is applied here rather than in memory so the
   * long tail of pairs that met once never leaves the database.
   *
   * Fail-soft: without pairs nothing merges and every term reports alone, which
   * is exactly the behaviour before clustering existed.
   */
  private async loadTermPairs(
    windowMatch: SQL,
    terms: readonly string[],
  ): Promise<TrendTermPair[]> {
    if (terms.length < 2) return [];

    try {
      // The post's candidate terms INTERSECTED with the ones that cleared the
      // floor, deduplicated — `select distinct`, for the same reason
      // `aggregateTermRows` needs it: the union is a concatenation, so a term
      // carried both as a hashtag and as an extracted term would appear twice
      // and pair with itself through the self-join.
      // Each term its OWN bound parameter. A JS array interpolated into a `sql`
      // template expands to a row constructor rather than binding as an array
      // (see `trendTermMatchSql`), and a term is arbitrary author-written text,
      // so neither a raw array cast nor string interpolation is available here.
      const floorTerms = sql.join(
        terms.map((term) => sql`${term}`),
        sql`, `,
      );
      const postTerms = (alias: string): SQL => sql`lateral (
        select distinct t.term
        from unnest(${trendCandidateUnionSql()}) as t(term)
        where t.term in (${floorTerms})
      ) as ${sql.raw(alias)}`;

      const rows = await getDb()
        .select({
          a: sql<string>`pair_a.term`,
          b: sql<string>`pair_b.term`,
          posts: sql`count(*)`.mapWith(Number),
        })
        .from(posts)
        // Self-join over the SAME per-post term set, one side renamed. `<` gives
        // each unordered pair exactly once and can never pair a term with
        // itself, which is what Mongo's `$expr: { $lt: … }` after the double
        // `$unwind` did. A post carrying fewer than two of the terms produces no
        // row at all, so there is nothing to pre-filter.
        .innerJoin(postTerms('pair_a'), sql`true`)
        .innerJoin(postTerms('pair_b'), sql`pair_b.term > pair_a.term`)
        .where(windowMatch)
        .groupBy(sql`pair_a.term, pair_b.term`)
        // Applied here rather than in memory so the long tail of pairs that met
        // once never leaves the database.
        .having(sql`count(*) >= ${MtnConfig.trending.clustering.minPairPosts}`);

      return rows.map((row) => ({ a: row.a, b: row.b, posts: row.posts }));
    } catch (error) {
      logger.warn('[Trending] Co-occurrence lookup failed; terms report individually', { error });
      return [];
    }
  }

  /**
   * How many posts the window held — the denominator of a term's share of the
   * corpus.
   *
   * Fail-soft to `null`: without it every candidate simply skips the vocabulary
   * ceiling, which is a weaker list for one batch. Throwing instead would trade
   * the whole batch for one guard.
   */
  private async countWindowPostsByLanguage(
    windowMatch: SQL,
  ): Promise<Map<string | null, number>> {
    const byLanguage = new Map<string | null, number>();
    try {
      const rows = await getDb()
        .select({
          language: posts.language,
          count: sql`count(*)`.mapWith(Number),
        })
        .from(posts)
        .where(windowMatch)
        .groupBy(posts.language);
      for (const row of rows) byLanguage.set(row.language, row.count);
    } catch (error) {
      logger.warn('[Trending] Corpus size lookup failed; vocabulary ceiling skipped', { error });
    }
    return byLanguage;
  }

  /**
   * Turn scored terms into the rows a batch stores: label, category, onset,
   * provenance type and registry linkage.
   *
   * Everything expensive here is scoped to the trends that actually made the
   * cut (at most `MtnConfig.trending.detection.maxTrends`), never to the
   * candidate space — which is the whole corpus's vocabulary.
   */
  private async buildTrendItems(
    ranked: readonly ScoredTrend[],
    candidates: readonly TermCandidate[],
    calculatedAt: Date,
  ): Promise<TrendItem[]> {
    if (ranked.length === 0) return [];

    const byTerm = new Map(candidates.map((candidate) => [candidate.measurement.term, candidate]));
    const terms = ranked.map((trend) => trend.term);

    const appearances = await this.loadTrendAppearances(terms, calculatedAt);
    const startedAt = new Map(
      terms.map((term) => [term, resolveTrendStartedAt(appearances.get(term) ?? [], calculatedAt)]),
    );

    // Only terms the CLASSIFIER produced are looked up in the topic registry.
    // `resolveNames` is a write-through registry call, so handing it arbitrary
    // words extracted from prose would fill the shared Topic registry with this
    // instance's vocabulary — a side effect trending has no business causing.
    const topicTerms = terms.filter((term) => (byTerm.get(term)?.topicVolume ?? 0) > 0);
    const [labels, topicMap] = await Promise.all([
      this.resolveTrendLabels(ranked, startedAt),
      topicService.resolveNames(topicTerms.map((name) => ({ name, type: TopicType.TOPIC }))),
    ]);

    return ranked.map((trend) => {
      const candidate = byTerm.get(trend.term);
      const topicDoc = topicMap.get(trend.term.toLowerCase());
      const label = labels.get(trend.term) ?? fallbackTrendLabel(trend.term);

      return {
        type: resolveTrendType({
          hasTopic: Boolean(topicDoc),
          topicVolume: candidate?.topicVolume ?? 0,
          hashtagVolume: candidate?.hashtagVolume ?? 0,
          volume: trend.volume,
        }),
        name: trend.term,
        terms: candidate?.members ?? [trend.term],
        displayName: label.displayName,
        category: label.category,
        description: '',
        score: trend.score,
        burstScore: trend.burstScore,
        volume: trend.volume,
        authorCount: trend.authorCount,
        momentum: trend.momentum,
        startedAt: startedAt.get(trend.term) ?? calculatedAt,
        ...(trend.status ? { status: trend.status } : {}),
        actorIds: candidate?.actorIds ?? [],
        languages: candidate?.languages ?? [],
        ...(topicDoc ? { topicId: topicDoc._id.toString() } : {}),
      };
    });
  }

  /**
   * The batch timestamps each term has appeared in, within the onset lookback —
   * the input {@link resolveTrendStartedAt} reconstructs a run from.
   *
   * Served by the `(name, calculated_at, type)` unique index (an exact prefix),
   * the same one the sparkline's range scan uses. Fail-soft: without history
   * every trend simply starts now, which is what a first-ever batch genuinely
   * means.
   */
  private async loadTrendAppearances(
    terms: readonly string[],
    calculatedAt: Date,
  ): Promise<Map<string, Date[]>> {
    const byTerm = new Map<string, Date[]>();
    if (terms.length === 0) return byTerm;

    try {
      const cutoff = new Date(calculatedAt.getTime() - MtnConfig.trending.detection.onsetLookbackMs);
      const rows = await getDb()
        .select({ name: trending.name, calculatedAt: trending.calculatedAt })
        .from(trending)
        .where(and(
          inArray(trending.name, [...terms]),
          gte(trending.calculatedAt, cutoff),
        ));

      for (const row of rows) {
        const existing = byTerm.get(row.name);
        if (existing) existing.push(row.calculatedAt);
        else byTerm.set(row.name, [row.calculatedAt]);
      }
    } catch (error) {
      logger.warn('[Trending] Onset history lookup failed; trends will start now', { error });
    }

    return byTerm;
  }

  /**
   * A label per ranked term: reused when the CURRENT run already has one,
   * generated for the rest.
   *
   * Reuse is scoped to the run (`calculatedAt >= startedAt`) and that boundary
   * is the whole point. Within a run the story is the same story, so renaming it
   * under a reader mid-scroll would be a bug; across runs the term is about
   * something new — `orioles` was a trade last week and is a no-hitter today —
   * so carrying the old headline forward would be worse than having none.
   */
  private async resolveTrendLabels(
    ranked: readonly ScoredTrend[],
    startedAt: ReadonlyMap<string, Date>,
  ): Promise<Map<string, TrendLabel>> {
    const labels = new Map<string, TrendLabel>();

    try {
      const earliestRun = Math.min(
        ...ranked.map((trend) => startedAt.get(trend.term)?.getTime() ?? Date.now()),
      );
      const rows = await getDb()
        .select({
          name: trending.name,
          displayName: trending.displayName,
          category: trending.category,
          calculatedAt: trending.calculatedAt,
        })
        .from(trending)
        .where(and(
          inArray(trending.name, ranked.map((trend) => trend.term)),
          gte(trending.calculatedAt, new Date(earliestRun)),
          sql`${trending.displayName} is not null`,
          // Only a label THESE rules produced may be carried forward. An older
          // one is re-derived, so a rules fix reaches a run already in progress
          // instead of waiting for it to end. `=` is total here because the
          // `is not null` above has already excluded the rows where a NULL
          // `label_version` would make the comparison NULL.
          eq(trending.labelVersion, TREND_LABEL_VERSION),
        ))
        .orderBy(desc(trending.calculatedAt));

      for (const row of rows) {
        // Sorted newest-first, so the first row seen for a term is its latest
        // label; the per-term run boundary is re-checked here because the query
        // could only narrow to the EARLIEST run across all of them.
        if (labels.has(row.name) || row.displayName === null) continue;
        const runStart = startedAt.get(row.name);
        if (runStart && row.calculatedAt < runStart) continue;
        labels.set(row.name, { displayName: row.displayName, category: row.category ?? 'other' });
      }
    } catch (error) {
      logger.warn('[Trending] Label reuse lookup failed; relabelling from scratch', { error });
    }

    const unlabelled = ranked
      .filter((trend) => !labels.has(trend.term))
      .slice(0, MtnConfig.trending.labeling.maxPerBatch);

    await Promise.all(
      unlabelled.map(async (trend) => {
        const excerpts = await this.loadTermExcerpts(trend.term);
        labels.set(trend.term, deriveTrendLabel({ term: trend.term, excerpts }));
      }),
    );

    // Anything past the per-batch labelling cap still needs a presentable name.
    for (const trend of ranked) {
      if (!labels.has(trend.term)) labels.set(trend.term, fallbackTrendLabel(trend.term));
    }

    return labels;
  }

  /**
   * A few recent posts carrying the term, as naming evidence.
   *
   * The term alone cannot name a story — `orioles` does not contain the words
   * "Kremer Trade" — so this is what makes a generated label better than string
   * formatting. Matched across the same three columns the term space is built
   * from, so a term that arrived as a hashtag or a topic slug still finds its
   * posts. Fail-soft: no excerpts simply means a weaker label.
   *
   * The body comes from the PRIMARY rendition (`position = 0` of
   * `post_content_variants`), which is the author's own words — the same one the
   * Mongo projection took. Ordered by `created_at` alone with no id tie-break:
   * `posts.id` mixes ObjectId hex and uuid v7 and is not a chronological axis,
   * and for a sample of twelve an arbitrary tie is not worth a wrong order.
   */
  private async loadTermExcerpts(term: string): Promise<string[]> {
    try {
      const rows = await getDb()
        .select({ text: postContentVariants.body })
        .from(posts)
        .innerJoin(
          postContentVariants,
          and(
            eq(postContentVariants.postId, posts.id),
            eq(postContentVariants.position, 0),
          ),
        )
        .where(and(
          trendTermMatchSql(term),
          eq(posts.status, 'published'),
          eq(posts.visibility, PostVisibility.PUBLIC),
          sensitiveExcludeSql(),
        ))
        .orderBy(desc(posts.createdAt))
        .limit(TREND_EXCERPTS_PER_TERM);

      return rows
        .map((row) => row.text?.trim() ?? '')
        .filter((text) => text.length > 0);
    } catch (error) {
      logger.warn('[Trending] Excerpt lookup failed; labelling without evidence', { term, error });
      return [];
    }
  }

  /**
   * Generate a lightweight AI summary from trend names.
   */
  private async generateSummary(trendNames: string[]): Promise<string> {
    if (!isAliaEnabled() || trendNames.length === 0) {
      return '';
    }

    try {
      const summary = await aliaChat(
        [
          {
            role: 'system',
            content: 'You are a social media trend analyst. Given a list of trending topics, write a 1-2 sentence summary of what people are talking about right now. Be natural and engaging. Vary the phrasing. Return ONLY the summary text.',
          },
          {
            role: 'user',
            content: `Trending: ${trendNames.join(', ')}`,
          },
        ],
        { temperature: 0.5 },
      );

      return summary.trim();
    } catch (error) {
      logger.warn('[Trending] Summary generation failed:', error);
      return '';
    }
  }

  /**
   * Save a batch of trends (append-only — does not delete previous batches).
   *
   * The insert is UNORDERED, which is the whole point. The rows of a batch are
   * independent measurements: no row is derived from another, and none needs to
   * land before the next. An ordered insert buys nothing here and costs a great
   * deal — it stops at the first rejected document, silently discarding every
   * remaining row, and the rejection then propagates out of `calculateTrending`
   * before the batch is ever published. One bad row therefore took down the whole
   * feature indefinitely. Unordered, the database attempts every document and
   * reports which ones it refused, so the same bad row costs exactly one trend.
   *
   * Rejections are RETURNED rather than thrown, and the caller decides: it logs
   * them at error level and still publishes the batch, unless nothing at all was
   * accepted. Swallowing them here would recreate the original defect in a quieter
   * form — a partial batch that nothing outside can distinguish from a whole one.
   */
  private async saveTrendingBatch(
    items: TrendItem[],
    calculatedAt: Date,
  ): Promise<TrendingBatchWrite> {
    if (items.length === 0) return { insertedCount: 0, rejected: [] };

    // Sort by score descending for ranking
    const sorted = [...items].sort((a, b) => b.score - a.score);

    const rows = sorted.map((item, index) => ({
      type: item.type as TrendingKind,
      name: item.name,
      // Only when the row actually stands for more than its own name: storing
      // `[name]` on every unmerged row would grow the collection to record a
      // fact the absent field already states.
      ...(item.terms.length > 1 ? { terms: item.terms } : {}),
      displayName: item.displayName,
      category: item.category,
      description: item.description,
      score: item.score,
      burstScore: item.burstScore,
      volume: item.volume,
      authorCount: item.authorCount,
      momentum: item.momentum,
      startedAt: item.startedAt,
      ...(item.status ? { status: item.status } : {}),
      ...(item.actorIds.length > 0 ? { actorIds: item.actorIds } : {}),
      ...(item.languages.length > 0 ? { languages: item.languages } : {}),
      rank: index + 1,
      ...(item.topicId ? { topicId: item.topicId } : {}),
      calculatedAt,
      updatedAt: new Date(),
    }));

    const db = getDb();
    /**
     * The rows that did NOT land, one entry per rejected ROW — a multiset
     * difference, not a set one. Two rows in a batch can in principle carry the
     * same `(name, type)`; one of them lands, and the other is still a
     * measurement that was dropped. Comparing sets would report it as fully
     * accepted, which is the quiet partial-batch the caller's error log exists
     * to prevent.
     *
     * The invariant this maintains is `insertedCount + rejected.length ===
     * rows.length`, so the log can never account for fewer trends than the batch
     * measured.
     */
    const rejectedOf = (accepted: Array<{ name: string; type: TrendingKind }>): string[] => {
      const remaining = new Map<string, number>();
      for (const row of accepted) {
        const key = trendKey(row.name, row.type);
        remaining.set(key, (remaining.get(key) ?? 0) + 1);
      }
      const rejected: string[] = [];
      for (const row of rows) {
        const key = trendKey(row.name, row.type);
        const left = remaining.get(key) ?? 0;
        if (left > 0) remaining.set(key, left - 1);
        else rejected.push(key);
      }
      return rejected;
    };

    try {
      const inserted = await db
        .insert(trending)
        .values(rows)
        .onConflictDoNothing({
          target: [trending.name, trending.calculatedAt, trending.type],
        })
        .returning({ name: trending.name, type: trending.type });
      logger.debug(`[Trending] Saved ${inserted.length} trends for batch ${calculatedAt.toISOString()}`);
      return { insertedCount: inserted.length, rejected: rejectedOf(inserted) };
    } catch (error) {
      // A multi-row INSERT is ONE statement: a constraint violation on any row
      // aborts the whole thing, which is exactly the all-or-nothing failure the
      // unordered Mongo insert existed to avoid. Retrying row by row restores
      // that property — every row is attempted, and a bad one costs exactly one
      // trend.
      logger.warn('[Trending] Batch insert failed; retrying row by row', {
        calculatedAt: calculatedAt.toISOString(),
        rows: rows.length,
        error: error instanceof Error ? error.message : String(error),
      });

      const accepted: Array<{ name: string; type: TrendingKind }> = [];
      for (const row of rows) {
        try {
          const landed = await db
            .insert(trending)
            .values(row)
            .onConflictDoNothing({
              target: [trending.name, trending.calculatedAt, trending.type],
            })
            .returning({ name: trending.name, type: trending.type });
          accepted.push(...landed);
        } catch (rowError) {
          logger.warn('[Trending] Rejected one trend', {
            trend: trendKey(row.name, row.type),
            error: rowError instanceof Error ? rowError.message : String(rowError),
          });
        }
      }
      return { insertedCount: accepted.length, rejected: rejectedOf(accepted) };
    }
  }

  /**
   * Get the latest batch of trends with its summary and its `recId`.
   *
   * The `recId` identifies the BATCH (see {@link mintTrendRecId}) and is what a
   * later `POST /trending/events` submits back, so the server can tell a press
   * on the current batch from one on a page a CDN served after the batch rotated.
   * It is derived from `calculatedAt` — already loaded here — rather than minted
   * per request, precisely because this result is cached and shared.
   *
   * This is also where batch staleness is observed, via {@link observeBatchAge}.
   * The read path is the honest place for it: the age is derived from persisted
   * state, so it survives a task restart and does not care which task holds
   * leadership — a job that dies, a job that never starts, and a leader that never
   * gets elected all show up identically here, which is exactly the property the
   * calculation-side counter lacks.
   */
  public async getTrending(
    limit: number = 20,
    type?: TrendingType,
    languages: readonly string[] = [],
  ): Promise<{ trending: TrendWithSeries[]; summary: string; recId?: string }> {
    // The reader's languages are part of the cache IDENTITY, not of a per-user
    // personalization: the route takes them as a query parameter precisely so
    // this stays a public, shared, CDN-cacheable read. The set is normalized and
    // sorted by the caller, so `es,en` and `en,es` are one entry rather than two.
    const languageKey = languages.length > 0 ? languages.join(',') : 'any';
    const cacheKey = `trending:latest:${limit}:${type || 'all'}:${languageKey}`;
    const redis = await getRedisClient();

    if (redis) {
      try {
        const cached = await redis.get(cacheKey);
        if (cached) {
          logger.debug('[Trending] Cache hit for latest trends');
          return JSON.parse(cached);
        }
      } catch (cacheError) {
        logger.warn('[Trending] Redis cache read failed:', cacheError);
      }
    }

    const db = getDb();
    // `trend_batches` carries the latest timestamp and summary in one row.
    const [latestBatch] = await db
      .select()
      .from(trendBatches)
      .orderBy(desc(trendBatches.calculatedAt))
      .limit(1);

    if (!latestBatch) return { trending: [], summary: '' };

    this.observeBatchAge(latestBatch.calculatedAt);

    /**
     * `(score desc, rank asc)` is already a strict total order HERE and needs no
     * tiebreak: the query is pinned to ONE batch, and `rank` is assigned `1..n`
     * over that batch's rows in `saveTrendingBatch`, so no two rows in scope can
     * share it. The `limit` therefore cuts a deterministic prefix.
     *
     * `type` is compared through `sql` rather than `eq()` because `TrendingType`
     * is a string ENUM and the column is typed as the literal union — the same
     * three strings, but TypeScript treats enums nominally and would reject the
     * assignment. The bound value is the enum's own string at runtime.
     *
     * Overfetched, then ordered by language match below: the reader's languages
     * decide the ORDER, never membership, so a quiet language cannot leave
     * somebody with an empty list.
     */
    const rows = await db
      .select()
      .from(trending)
      .where(
        and(
          eq(trending.calculatedAt, latestBatch.calculatedAt),
          type ? sql`${trending.type} = ${type}` : undefined,
        ),
      )
      .orderBy(desc(trending.score), asc(trending.rank))
      .limit(limit * LANGUAGE_OVERFETCH);

    const trends = orderByLanguageMatch(rows.map(serializeTrend), languages).slice(0, limit);

    // Only reached on a cache MISS. The entry below is warmed right after each
    // recalculation (see warmDefaultCache), so these run on the order of once per
    // 30-minute batch per requested shape — not once per reader.
    const [series, actors] = await Promise.all([
      this.loadVolumeSeries(trends),
      this.loadTrendActors(trends),
    ]);

    const result = {
      trending: trends.map((trend): TrendWithSeries => {
        const points = series.get(trend.name);
        const faces = trend.actorIds
          ?.map((actorId) => actors.get(actorId))
          .filter((user): user is PostUser => Boolean(user));
        return {
          ...trend,
          ...(points ? { series: points } : {}),
          ...(faces && faces.length > 0 ? { actors: faces } : {}),
        };
      }),
      summary: latestBatch.summary,
      recId: mintTrendRecId(latestBatch.calculatedAt),
    };

    if (redis && trends.length > 0) {
      try {
        await redis.setEx(cacheKey, this.REDIS_CACHE_TTL, JSON.stringify(result));
      } catch (cacheError) {
        logger.warn('[Trending] Redis cache write failed:', cacheError);
      }
    }

    return result;
  }

  /**
   * Recent `volume` history for the given trends, keyed by TERM.
   *
   * The `trending` table is the ONLY per-term time series that exists: the job
   * appends a full batch every 30 minutes and keeps 90 days, and the unique
   * `(name, calculated_at, type)` index serves this range scan directly. (The
   * obvious-looking alternative, `topic_stats`, holds one current-value row per
   * topic and no history whatsoever.) `array_agg` is ordered EXPLICITLY by
   * `calculated_at` rather than relying on the scan order: an aggregate's input
   * order is not guaranteed in Postgres, so an unordered one would draw a
   * sparkline whose points are in whatever sequence the planner produced.
   *
   * Keyed on the NAME alone. It used to be keyed on (name, type), because a name
   * could be measured twice in one batch — once as a hashtag, once as a topic —
   * and interleaving two unrelated quantities would have drawn a zig-zag. Those
   * lanes are gone: a term is measured once, and `type` is now provenance that
   * can flip between batches as the mix of posts spelling it with a `#` shifts.
   * Keeping `type` in the key would therefore cut one continuous history in two
   * at the flip and drop both halves below the drawing floor.
   *
   * A name absent from a batch contributes NO point rather than a zero: it means
   * the trend fell out of the reporting threshold that batch, which is not the
   * same as nobody posting it. Guessing would be exactly the kind of invented
   * data this feature exists to avoid, so short runs are simply dropped by the
   * floor in {@link buildTrendSeries}.
   *
   * DELIBERATELY NOT wired into `getTrendingHistory`. That route is an archive of
   * what trended on days past, and the series here is anchored to `now` — a row
   * from forty days ago would be handed the last 24 hours of a name it was not
   * trending in. Anchoring per archived batch instead would mean one range scan
   * per (name, day) pair — up to 20 days × 20 trends — to decorate a page nobody
   * reads for live movement. Same reasoning that already keeps `recId` off it: an
   * archive is not a recommendation.
   *
   * Fail-soft: an aggregation failure costs the sparkline, never the trend list.
   */
  private async loadVolumeSeries(
    trends: Array<Pick<SerializedTrend, 'name'>>,
  ): Promise<Map<string, number[]>> {
    const byTrend = new Map<string, number[]>();
    if (trends.length === 0) return byTrend;

    // The `$match` narrows on name — the index's leading field — and the group
    // collapses each name's batches into one series in time order.
    const names = [...new Set(trends.map((trend) => trend.name))];

    try {
      const cutoff = new Date(Date.now() - MtnConfig.trending.series.windowMs);
      const rows = await getDb()
        .select({
          name: trending.name,
          volumes: sql<number[]>`array_agg(${trending.volume} order by ${trending.calculatedAt})`,
        })
        .from(trending)
        .where(and(
          inArray(trending.name, names),
          gte(trending.calculatedAt, cutoff),
        ))
        .groupBy(trending.name);

      for (const row of rows) {
        const series = buildTrendSeries(row.volumes);
        if (series) byTrend.set(row.name, series);
      }
    } catch (error) {
      logger.warn('[Trending] Volume series lookup failed:', error);
    }

    return byTrend;
  }

  /**
   * Everything the trend screen needs to present a term: what it is called, how
   * it is filed, and its summary if it has earned one.
   *
   * The presentation travels in the RESPONSE rather than in the URL. A label
   * passed as a query parameter would make `/trend/politics` and
   * `/trend/politics?label=Politics` two addresses for one resource, freeze a
   * shared link's title at the moment it was copied — so it lies the next time
   * the term is relabelled — and let anyone hand a reader a fabricated name.
   * The row this reads is the same one the `startedAt` lookup already fetches,
   * so carrying the label costs nothing.
   *
   * The on-demand summary for a trend a reader just opened.
   *
   * The run is read from the STORED row for the current batch, never from the
   * request: it is the identity a summary is generated and cached under, so a
   * caller-supplied one would let anyone mint unlimited cache keys — and with
   * them, unlimited generations — for a single term. The same lookup is what
   * restricts generation to terms that are actually trending right now.
   *
   * Excerpts are passed as a THUNK so the query only runs when a generation is
   * actually due: the overwhelming majority of calls are a single indexed read
   * that finds an existing summary, or a counter increment below the threshold.
   */
  public async getTrendSummary(term: string): Promise<TrendDetail> {
    const normalized = term.trim().toLowerCase();
    if (!normalized) return {};

    const db = getDb();
    const [latestBatch] = await db
      .select({ calculatedAt: trendBatches.calculatedAt })
      .from(trendBatches)
      .orderBy(desc(trendBatches.calculatedAt))
      .limit(1);
    if (!latestBatch) return {};

    const [row] = await db
      .select({
        startedAt: trending.startedAt,
        displayName: trending.displayName,
        category: trending.category,
      })
      .from(trending)
      .where(and(
        eq(trending.name, normalized),
        eq(trending.calculatedAt, latestBatch.calculatedAt),
      ))
      .limit(1);
    // Not in the current batch, or written before onset tracking: either way
    // there is no run to attribute a summary to, so there is nothing to do.
    if (!row?.startedAt) return {};

    const summary = await resolveTrendSummary({
      term: normalized,
      runStartedAt: row.startedAt,
      loadExcerpts: () => this.loadTermExcerpts(normalized),
    });

    return {
      ...summary,
      ...(row.displayName ? { displayName: row.displayName } : {}),
      ...(row.category ? { category: row.category } : {}),
    };
  }

  /**
   * Resolve the stored actor ids of a page of trends into renderable users.
   *
   * ONE batched call for the whole page (at most `limit × maxActors` ids), on
   * the same Redis-backed resolver feed hydration uses — never a per-trend or
   * per-actor fetch, which is the N+1 this resolver exists to collapse.
   *
   * Fail-soft: a resolution failure costs the faces, never the trends. Degraded
   * (unresolvable) ids are dropped rather than rendered, on the same rule the
   * rest of the app follows — an avatar with no identity behind it is not
   * evidence that people are posting, which is the only thing these faces claim.
   */
  private async loadTrendActors(
    trends: readonly Pick<SerializedTrend, 'actorIds'>[],
  ): Promise<Map<string, PostUser>> {
    const resolved = new Map<string, PostUser>();
    const actorIds = [...new Set(trends.flatMap((trend) => trend.actorIds ?? []))];
    if (actorIds.length === 0) return resolved;

    try {
      for (const [actorId, summary] of await resolveUserSummaries(actorIds)) {
        if (!isFallbackUserSummary(summary.user)) resolved.set(actorId, summary.user);
      }
    } catch (error) {
      logger.warn('[Trending] Actor resolution failed; trends will render without faces', { error });
    }

    return resolved;
  }

  /**
   * Publish how old the batch being served actually is.
   *
   * The defect this exists for is not that the job can fail — it always could —
   * but that a frozen batch is indistinguishable from a fresh one from outside:
   * `GET /trending` answered 200 with a full, plausible payload for over a day
   * while every recalculation behind it was dying. The gauge makes the age
   * alertable, and the log gives a human reading the logs the same fact.
   *
   * Only reached on a cache miss, which is roughly once per batch per requested
   * shape — the right frequency for a health observation and nowhere near a hot
   * path. Never throws: an observation must not be able to fail a read.
   */
  private observeBatchAge(calculatedAt: Date): void {
    const ageMs = Date.now() - calculatedAt.getTime();
    metrics.setGauge('trending_batch_age_seconds', Math.max(0, Math.round(ageMs / 1000)));

    if (ageMs > this.STALE_BATCH_AFTER_MS) {
      logger.error('[Trending] Serving a stale batch — recalculation is not landing', {
        calculatedAt: calculatedAt.toISOString(),
        ageSeconds: Math.round(ageMs / 1000),
        staleAfterSeconds: Math.round(this.STALE_BATCH_AFTER_MS / 1000),
      });
    }
  }

  /**
   * The `recId` of the batch that is current RIGHT NOW — what a submitted token
   * is compared against to derive the bounded `freshness` label.
   *
   * Memoized in process for {@link CURRENT_REC_ID_TTL_MS} because this is read on
   * the telemetry hot path, where a database round trip per reported press would
   * cost far more than the measurement is worth. The memo is deliberately much
   * shorter than the 30-minute batch interval, so a rotation shows up almost
   * immediately; a stale-by-seconds token would only ever mislabel presses that
   * land in that window, and it never blocks the write.
   *
   * Fail-soft: `null` on any error, which the telemetry module reads as
   * `unknown` rather than declaring every press stale.
   */
  public async getCurrentRecId(): Promise<string | null> {
    const now = Date.now();
    if (this.currentRecIdCache && this.currentRecIdCache.expiresAt > now) {
      return this.currentRecIdCache.value;
    }

    try {
      const [latestBatch] = await getDb()
        .select({ calculatedAt: trendBatches.calculatedAt })
        .from(trendBatches)
        .orderBy(desc(trendBatches.calculatedAt))
        .limit(1);
      const value = latestBatch ? mintTrendRecId(latestBatch.calculatedAt) : null;
      this.currentRecIdCache = { value, expiresAt: now + CURRENT_REC_ID_TTL_MS };
      return value;
    } catch (error) {
      logger.warn('[Trending] Current recId lookup failed:', error);
      return null;
    }
  }

  /**
   * Get paginated trending history grouped by day.
   *
   * Collapses each day's ~48 batches to one row per trend, keeping the highest
   * score. A trend is a (name, type) pair, so that is the collapse key: a name
   * that trended both as a hashtag and as a classified topic is two trends, and
   * keying on the name alone would silently drop whichever scored lower.
   *
   * Both passes are WINDOWED: each filters `calculated_at >= cutoff` (now −
   * retention window) so the planner narrows through `trending_calculated_at_idx`
   * instead of scanning the whole table. The result is cached in Redis per
   * `page:limit` with a short TTL so repeat loads are cache reads. Both the
   * window and the cache are fail-soft.
   */
  public async getTrendingHistory(
    page: number = 1,
    limit: number = 10,
  ): Promise<{ days: Array<{ date: string; trends: SerializedTrend[] }>; page: number; totalPages: number }> {
    const cacheKey = `trending:history:${page}:${limit}`;
    const redis = await getRedisClient();

    if (redis) {
      try {
        const cached = await redis.get(cacheKey);
        if (cached) {
          logger.debug('[Trending] Cache hit for trending history');
          return JSON.parse(cached);
        }
      } catch (cacheError) {
        logger.warn('[Trending] Redis history cache read failed:', cacheError);
      }
    }

    // Only scan the retained window. Computed per-call (never at module scope).
    const cutoff = new Date(Date.now() - this.HISTORY_WINDOW_MS);
    const db = getDb();

    /**
     * The calendar day a batch belongs to, in UTC.
     *
     * `at time zone 'UTC'` is not optional. Mongo's `$dateToString` with no
     * `timezone` renders in UTC, while `to_char` on a `timestamptz` renders in
     * the SESSION's `TimeZone` — so without it the day boundaries would shift
     * with whatever the connection happened to be set to, silently re-bucketing
     * every archived trend and changing the page count.
     */
    const dayExpr = sql<string>`to_char(${trending.calculatedAt} at time zone 'UTC', 'YYYY-MM-DD')`;

    // Distinct days within the window, newest first.
    const allDays = await db
      .selectDistinct({ day: dayExpr.as('day') })
      .from(trending)
      .where(gte(trending.calculatedAt, cutoff))
      .orderBy(sql`day desc`);

    const totalPages = Math.ceil(allDays.length / limit);
    const start = (page - 1) * limit;
    const pageDays = allDays.slice(start, start + limit).map((row) => row.day);

    if (pageDays.length === 0) {
      return { days: [], page, totalPages };
    }

    /**
     * Two window passes replace Mongo's `$sort`/`$group $first` and
     * `$group $push`/`$slice`, and BOTH orderings end in `id` for the same
     * reason: neither `$group $first` nor `$slice` had a total order to work
     * with, so both silently picked an arbitrary row out of a tie — the same
     * page could answer differently on two requests. `score desc, id desc` is
     * total (`id` is the primary key), so a tie now resolves the same way every
     * time.
     *
     * `dedupRank = 1` keeps the highest-scoring row per (day, name, type) —
     * a trend is a (name, type) PAIR, so a name that trended as both a hashtag
     * and a classified topic stays two trends here, exactly as it does in a live
     * batch. `dayRank` then cuts each day to its top {@link HISTORY_TRENDS_PER_DAY}.
     */
    const deduped = db
      .select({
        ...getTableColumns(trending),
        day: dayExpr.as('day'),
        dedupRank: sql<number>`row_number() over (
          partition by ${dayExpr}, ${trending.name}, ${trending.type}
          order by ${trending.score} desc, ${trending.id} desc
        )`.as('dedup_rank'),
      })
      .from(trending)
      .where(and(gte(trending.calculatedAt, cutoff), inArray(dayExpr, pageDays)))
      .as('deduped');

    const ranked = db
      .select({
        ...deduped._.selectedFields,
        dayRank: sql<number>`row_number() over (
          partition by ${deduped.day} order by ${deduped.score} desc, ${deduped.id} desc
        )`.as('day_rank'),
      })
      .from(deduped)
      .where(eq(deduped.dedupRank, 1))
      .as('ranked');

    const rows = await db
      .select()
      .from(ranked)
      .where(lte(ranked.dayRank, HISTORY_TRENDS_PER_DAY))
      .orderBy(desc(ranked.day), desc(ranked.score), desc(ranked.id));

    // Group by day in insertion order, which the ORDER BY already made `day desc`.
    const byDay = new Map<string, SerializedTrend[]>();
    for (const row of rows) {
      const bucket = byDay.get(row.day);
      if (bucket) bucket.push(serializeTrend(row));
      else byDay.set(row.day, [serializeTrend(row)]);
    }
    const days = [...byDay].map(([date, trends]) => ({ date, trends }));

    const result = { days, page, totalPages };

    if (redis && days.length > 0) {
      try {
        await redis.setEx(cacheKey, this.REDIS_HISTORY_CACHE_TTL, JSON.stringify(result));
      } catch (cacheError) {
        logger.warn('[Trending] Redis history cache write failed:', cacheError);
      }
    }

    return result;
  }

  /**
   * Warm the default `getTrending` cache entry so the first read after a cache
   * invalidation is a hit rather than a cold aggregate. Reuses the normal read
   * path (which populates the cache on a miss) so the warmed value has the exact
   * same shape a request would produce. Fail-soft — a warm failure never breaks
   * the calculation.
   */
  private async warmDefaultCache(): Promise<void> {
    try {
      await this.getTrending(this.DEFAULT_TRENDING_LIMIT);
    } catch (error) {
      logger.warn('[Trending] Default cache warm failed:', error);
    }
  }

  /**
   * Remove trends older than CLEANUP_DAYS (= the 90-day retention window) to
   * prevent unbounded growth. `trending` also has an entry in the expiry
   * registry (`db/expiry.ts`), the direct successor of its Mongo TTL index — so
   * this delete is redundant for that table. It is retained because
   * `trend_batches` has NO expiry entry and this is the only thing keeping it
   * bounded. Both are cleaned to the SAME cutoff so trend batches and their
   * trends expire together, and `getTrending` can never read a batch whose rows
   * have been reaped.
   *
   * `returning` gives the count. Mongo's `deletedCount` came free; here the rows
   * have to be asked for, and the id alone is enough to count them.
   */
  private async cleanupOldTrends(): Promise<void> {
    try {
      const cutoff = new Date(Date.now() - this.CLEANUP_DAYS * 24 * 60 * 60 * 1000);
      const db = getDb();
      const deleted = await db
        .delete(trending)
        .where(lt(trending.calculatedAt, cutoff))
        .returning({ id: trending.id });
      await db.delete(trendBatches).where(lt(trendBatches.calculatedAt, cutoff));

      if (deleted.length > 0) {
        logger.info(`[Trending] Cleaned up ${deleted.length} trends older than ${this.CLEANUP_DAYS} days`);
      }
    } catch (error) {
      logger.warn('[Trending] Cleanup failed:', error);
    }
  }

  /**
   * Invalidate Redis cache.
   */
  private async invalidateCache(): Promise<void> {
    try {
      const redis = await getRedisClient();
      if (!redis) return;

      const keys = await redis.keys('trending:*');
      if (keys.length > 0) {
        await redis.del(keys);
        logger.debug(`[Trending] Invalidated ${keys.length} cache keys`);
      }
    } catch {
      // Redis unavailable — cache invalidation skipped silently
    }
  }
}

// Export singleton instance
export const trendingService = new TrendingService();
