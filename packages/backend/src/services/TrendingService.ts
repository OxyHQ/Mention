import {
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  gte,
  inArray,
  isNull,
  lt,
  lte,
  sql,
} from 'drizzle-orm';
import { MtnConfig, PostVisibility } from '@mention/shared-types';
import { TopicType } from '@oxyhq/core';
import { qualified } from '../db/casing';
import { getDb } from '../db/postgres';
import {
  TRENDING_RETENTION_SECONDS,
  TRENDING_TYPES,
  trendBatches,
  trending,
} from '../db/schema/discovery';
import { postClassificationTopicRefs } from '../db/schema/postContent';
import { posts } from '../db/schema/posts';
import { TrendingType } from '../models/Trending';
import { logger } from '../utils/logger';
import { getRedisClient } from '../utils/redis';
import { emitTrendsUpdated } from '../utils/socket';
import { aliaChat, isAliaEnabled } from '../utils/alia';
import { topicService } from './TopicService';
import { isNsfwHashtag } from './contentClassification/nsfw';
// Trending shares the SINGLE canonical sensitive-exclusion clause with every
// feed (For You, Explore, ranking). Adding a new gate updates trending too.
import { SENSITIVE_EXCLUDE_SQL } from '../mtn/feed/feedSafety';
import { mintTrendRecId } from './trending/trendTelemetry';
import { buildTrendSeries } from './trending/trendSeries';
import { metrics } from '../utils/metrics';

/**
 * How long the current batch's `recId` is memoized in process. Far shorter than
 * the 30-minute batch interval so a rotation is picked up almost immediately,
 * long enough that a burst of reported presses costs at most one database read.
 */
const CURRENT_REC_ID_TTL_MS = 30_000;

/** How many trends one archived day carries in `GET /trending/history`. */
const HISTORY_TRENDS_PER_DAY = 20;

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
type TrendingKind = (typeof TRENDING_TYPES)[number];

interface TrendItem {
  type: TrendingKind;
  name: string;
  description: string;
  score: number;
  volume: number;
  momentum: number;
  topicId?: string;
}

/**
 * A trend exactly as it leaves the process, matching what Mongoose's `.lean()`
 * produced field-for-field.
 *
 * `_id` is the id under its Mongo name because that is what the wire has always
 * carried; the frontend deliberately does not read it (`stores/trendsStore.ts`
 * says so in as many words), but a port may not change a response body.
 * `topicId` is OMITTED rather than sent as `null` when a trend resolved to no
 * registry topic — Mongoose's `undefined` disappeared from the JSON and
 * drizzle's `null` would not. `__v` is NOT carried over: it is Mongo bookkeeping
 * that no reader has ever looked at, and the schema forbids it.
 */
export interface SerializedTrend {
  _id: string;
  type: TrendingKind;
  name: string;
  description: string;
  score: number;
  volume: number;
  momentum: number;
  rank: number;
  topicId?: string;
  calculatedAt: Date;
  updatedAt: Date;
}

function serializeTrend(row: typeof trending.$inferSelect): SerializedTrend {
  return {
    _id: row.id,
    type: row.type,
    name: row.name,
    description: row.description,
    score: row.score,
    volume: row.volume,
    momentum: row.momentum,
    rank: row.rank,
    ...(row.topicId === null ? {} : { topicId: row.topicId }),
    calculatedAt: row.calculatedAt,
    updatedAt: row.updatedAt,
  };
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
 * Identity of a trend within a batch, matching the `{ name, calculatedAt, type }`
 * uniqueness key. Used to key the volume series, because a name that trends as
 * both a hashtag and a topic is two series, not one — pushing both into a single
 * array would draw a sparkline that alternates between two unrelated measurements.
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
export type TrendWithSeries = SerializedTrend & { series?: number[] };

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
  // history at 30d). `db/expiry.ts` reads the SAME constant for its sweep.
  private readonly CLEANUP_DAYS = TRENDING_RETENTION_SECONDS / (24 * 60 * 60); // 90 days
  // Default `limit` for the public trending list (mirrors the GET /trending
  // route default). Warmed into Redis after each recalculation so the most
  // common request is a cache hit, never a cold aggregate.
  private readonly DEFAULT_TRENDING_LIMIT = 20;
  // History query window, in milliseconds, derived from the table's retention
  // constant so the window never asks for data the expiry sweep has reaped.
  private readonly HISTORY_WINDOW_MS = TRENDING_RETENTION_SECONDS * 1000;
  // How old the served batch may get before it is reported as stale. Derived from
  // the calculation cadence rather than fixed, so the two can never drift apart.
  // Three cadences: one missed run is a blip (a leader handover, a slow database),
  // three in a row is the job not landing, which is what went unnoticed for a day.
  private readonly STALE_BATCH_AFTER_MS = this.CALCULATION_INTERVAL * 3;

  /**
   * Relevance contributed by a canonical topic ref that carries no `relevance`
   * (AI/rule topics are slug-only). Mid-scale on the 1..10 relevance axis so a
   * slug-only topic counts toward trending without dominating the relevance-aware
   * scoring; matches the neutral "present but unweighted" intent.
   */
  private static readonly DEFAULT_TOPIC_RELEVANCE = 5;

  /** A topic needs at least this many posts in the window to count as trending. */
  private static readonly MIN_TOPIC_POST_COUNT = 2;

  /** Only the top N topics enter a batch; hashtags are unbounded. */
  private static readonly MAX_TOPIC_TRENDS = 15;

  /**
   * Initialize the service and start periodic calculations.
   *
   * Leader-gated by design: this is invoked ONLY from `startSchedulers()` in
   * `server.ts`, which `LeaderElection` runs on exactly one backend task. Non-
   * leader tasks never compute trends — they serve reads from the shared
   * `Trending` collection / Redis cache. Same pattern as every other periodic
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
   * `trend_batches` is what `getTrending` reads the current timestamp from, so it is
   * created only once the rows it points at exist. The failure this ordering
   * guards against is not hypothetical: a batch write that died partway left the
   * batch row uncreated, and the endpoint then served its last complete batch
   * for over a day — HTTP 200, full payload, no external sign anything was wrong.
   * Hence the outcome counter here, and the age gauge in {@link getTrending}: the
   * job failing and the job never running must both be visible from outside.
   */
  public async calculateTrending(): Promise<void> {
    try {
      logger.info('[Trending] Starting trending calculation');

      const calculatedAt = new Date();
      const hashtagTrends = await this.aggregateHashtags();
      const topicTrends = await this.aggregateTopics();

      // Resolve topic names to Topic documents (topics + entities only, not hashtags)
      const topicEntries = topicTrends.map(t => ({
        name: t.name,
        type: t.type === 'entity' ? TopicType.ENTITY : TopicType.TOPIC,
      }));
      const topicMap = await topicService.resolveNames(topicEntries);

      // Attach topicIds to trend items
      for (const trend of topicTrends) {
        const topicDoc = topicMap.get(trend.name.toLowerCase());
        if (topicDoc) {
          trend.topicId = topicDoc._id.toString();
        }
      }

      const allTrends: TrendItem[] = [...hashtagTrends, ...topicTrends];

      // Generate AI summary from top trend names
      const topTopicNames = topicTrends.slice(0, 10).map(t => t.name);
      const topHashtagNames = hashtagTrends.slice(0, 10).map(h => `#${h.name}`);
      // `flatMap` rather than `filter` + `map`: it narrows the optional
      // `topicId` to a `string` without a non-null assertion.
      const popularityUpdates = topicTrends.flatMap(t =>
        t.topicId ? [{ topicId: t.topicId, trendingScore: t.score }] : [],
      );

      // Run AI summary generation, trend persistence, and popularity updates in parallel
      const [summary, write] = await Promise.all([
        this.generateSummary([...topTopicNames, ...topHashtagNames]),
        this.saveTrendingBatch(allTrends, calculatedAt),
        topicService.updatePopularityFromTrending(popularityUpdates),
      ]);

      // Nothing accepted out of a non-empty batch: publishing the `trend_batches`
      // row would point readers at rows that do not exist and blank the widget, which
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
        `[Trending] Saved batch: ${hashtagTrends.length} hashtags + ${topicTrends.length} topics (${popularityUpdates.length} topic popularities updated)`,
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
   * The `posts` predicate both aggregations share: public, published, non-boost,
   * created inside the 24-hour window, and not sensitive.
   *
   * `boost_of is null` is Mongo's `boostOf: {$exists: false}` — a boost carries no
   * hashtags or topics of its own and would double-count the original's.
   */
  private static recentPublicPostsMatch(oneDayAgo: Date) {
    return and(
      gte(posts.createdAt, oneDayAgo),
      eq(posts.status, 'published'),
      eq(posts.visibility, PostVisibility.PUBLIC),
      isNull(posts.boostOf),
      SENSITIVE_EXCLUDE_SQL,
    );
  }

  /**
   * Aggregate trending hashtags from recent posts in a single query.
   *
   * Mongo's `$unwind` over the multikey `hashtags` array becomes a `lateral
   * unnest`, and the `$cond`-inside-`$sum` that counted the six-hour subset
   * becomes an aggregate FILTER — which is the same single pass over the same
   * rows, not a second query.
   *
   * `{ $exists: true, $ne: [] }` on `hashtags` has no counterpart and needs none:
   * `unnest` of NULL or of an empty array produces no rows, so a post with no
   * hashtags already contributes nothing.
   *
   * `.mapWith(Number)` on both counts is required, not stylistic — postgres.js
   * returns `count()` as a STRING (`int8` on the wire), and an unmapped one would
   * flow into the momentum arithmetic as `'12'` and produce a plausible-looking
   * wrong score rather than an error.
   */
  private async aggregateHashtags(): Promise<TrendItem[]> {
    const now = new Date();
    const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const sixHoursAgo = new Date(now.getTime() - 6 * 60 * 60 * 1000);

    const hashtagCounts = await getDb()
      .select({
        tag: sql<string>`hashtag.tag`,
        count24h: sql`count(*)`.mapWith(Number),
        count6h: sql`count(*) filter (where ${gte(posts.createdAt, sixHoursAgo)})`.mapWith(Number),
      })
      .from(posts)
      .innerJoin(sql`lateral unnest(${posts.hashtags}) as hashtag(tag)`, sql`true`)
      .where(TrendingService.recentPublicPostsMatch(oneDayAgo))
      .groupBy(sql`hashtag.tag`);

    const trends: TrendItem[] = hashtagCounts
      // Drop blocklisted NSFW/adult hashtags even if they appear on
      // non-sensitive posts (case-insensitive, normalized in isNsfwHashtag).
      .filter(item => !isNsfwHashtag(item.tag))
      .map(item => {
        const hashtagName = item.tag.toLowerCase();
        const volume24h = item.count24h;
        const volume6h = item.count6h;

        const momentum = volume24h > 0 ? (volume6h * 4) / volume24h : 0;
        const score = volume24h * (1 + momentum * 0.5);

        return {
          type: 'hashtag' as const,
          name: hashtagName,
          description: '',
          score,
          volume: volume24h,
          momentum: Math.min(momentum, 1),
        };
      });

    trends.sort((a, b) => b.score - a.score);
    return trends;
  }

  /**
   * Aggregate trending topics from per-post classified topics.
   *
   * Reads the canonical `postClassification.topicRefs` when present and FALLS
   * BACK to the slug-only `postClassification.topics` per post (`$ifNull` on a
   * non-empty topicRefs array). The slug list is the rule-based Stage-A baseline
   * every classified post carries; each slug string is normalized to
   * `{ name: <slug> }` so the unwind/group reads `name` uniformly. The window is
   * keyed on the post's `createdAt` so both sources share one time basis. Slug
   * topics carry no `relevance`/`type`, so missing relevance contributes
   * {@link TrendingService.DEFAULT_TOPIC_RELEVANCE} and missing type defaults to
   * a TOPIC — never an `entity`. Posts with neither topic source contribute
   * nothing (the unified source is `[]`).
   *
   * ## The two sources are a UNION, and the fallback is exclusive
   *
   * Mongo expressed "prefer refs, else slugs" as a `$cond` inside `$addFields`,
   * which Postgres has no equivalent for because the two live in different
   * places: refs are rows in `post_classification_topic_refs`, slugs are a
   * `text[]` on the post. So it is a `union all` of two branches, and the slug
   * branch carries a `not exists` on the refs table — that predicate IS the
   * `$cond`, and dropping it would double-count every post that has both.
   *
   * `qualified()` on that `not exists` is defensive, and the reason is measured
   * rather than assumed: drizzle 0.45.2 strips a column's table prefix in exactly
   * one position — the SELECT LIST of a SINGLE-table select — so a `where` clause
   * (and this one sits in a multi-table select besides) renders qualified on its
   * own. It is spelled out because both of those are properties of the
   * surrounding query rather than of this predicate: rendered bare,
   * `where "post_id" = "id"` compares two columns of the refs table to each
   * other, matches nothing, and every post silently takes the slug branch as well
   * as the ref branch — the wrong answer with no error.
   *
   * Mongo's outer `$or` ("at least one topic source is present") is dropped
   * rather than ported: the join and the `unnest` each already contribute
   * nothing for a post with no source, so it was only ever an index hint.
   */
  private async aggregateTopics(): Promise<TrendItem[]> {
    const db = getDb();
    const now = new Date();
    const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const sixHoursAgo = new Date(now.getTime() - 6 * 60 * 60 * 1000);
    const baseMatch = TrendingService.recentPublicPostsMatch(oneDayAgo);

    // Canonical refs. A ref may omit `type` (default `topic`, never `entity`) and
    // may omit `relevance` (a neutral mid-scale value), exactly as `$ifNull` did.
    const refBranch = db
      .select({
        name: postClassificationTopicRefs.name,
        type: sql<string>`coalesce(${postClassificationTopicRefs.type}, 'topic')`.as('type'),
        relevance: sql<number>`coalesce(${postClassificationTopicRefs.relevance}, ${TrendingService.DEFAULT_TOPIC_RELEVANCE})`.as('relevance'),
        createdAt: posts.createdAt,
      })
      .from(posts)
      .innerJoin(postClassificationTopicRefs, eq(postClassificationTopicRefs.postId, posts.id))
      .where(baseMatch);

    // Slug-only Stage-A baseline, for posts that resolved NO refs at all.
    const slugBranch = db
      .select({
        name: sql<string>`slug.name`.as('name'),
        type: sql<string>`'topic'`.as('type'),
        relevance: sql<number>`${TrendingService.DEFAULT_TOPIC_RELEVANCE}`.as('relevance'),
        createdAt: posts.createdAt,
      })
      .from(posts)
      .innerJoin(sql`lateral unnest(${posts.classificationTopics}) as slug(name)`, sql`true`)
      .where(
        and(
          baseMatch,
          sql`not exists (
            select 1 from ${postClassificationTopicRefs}
            where ${qualified(postClassificationTopicRefs.postId)} = ${qualified(posts.id)}
          )`,
        ),
      );

    const source = db.$with('topic_source').as(refBranch.unionAll(slugBranch));

    const topicCounts = await db
      .with(source)
      .select({
        name: source.name,
        type: source.type,
        totalRelevance: sql`sum(${source.relevance})`.mapWith(Number),
        postCount: sql`count(*)`.mapWith(Number),
        recentCount: sql`count(*) filter (where ${gte(source.createdAt, sixHoursAgo)})`.mapWith(Number),
      })
      .from(source)
      .groupBy(source.name, source.type)
      .having(sql`count(*) >= ${TrendingService.MIN_TOPIC_POST_COUNT}`);

    const trends: TrendItem[] = topicCounts
      // Drop blocklisted NSFW/adult topic slugs from trending topics.
      .filter(item => !isNsfwHashtag(item.name))
      .map(item => {
        const momentum = item.postCount > 0
          ? Math.min((item.recentCount * 4) / item.postCount, 1)
          : 0;
        const score = item.totalRelevance * (1 + momentum * 0.5);

        return {
          type: item.type === 'topic' ? ('topic' as const) : ('entity' as const),
          name: item.name,
          description: '',
          score,
          volume: item.postCount,
          momentum,
        };
      });

    trends.sort((a, b) => b.score - a.score);
    return trends.slice(0, TrendingService.MAX_TOPIC_TRENDS);
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
   * The rows of a batch are independent measurements: no row is derived from
   * another, and none needs to land before the next. That is what an unordered
   * Mongo insert bought, and it is what has to survive the port — the incident
   * this defends against is not hypothetical. An ORDERED insert stopped at the
   * first rejected document, silently discarded every remaining row, and let the
   * rejection propagate out of `calculateTrending` BEFORE the batch was
   * published; since `getTrending` derives its timestamp from `trend_batches`,
   * one bad row froze `GET /trending` on its previous batch for over a day while
   * answering 200 the whole time.
   *
   * A Postgres multi-row INSERT is all-or-nothing, so the resilience has to be
   * written out rather than requested with a flag:
   *
   *  1. ONE statement with `on conflict do nothing`, which absorbs the documented
   *     failure — a duplicate `(name, calculated_at, type)`. This is also
   *     strictly better than Mongo was: two rows that collide WITHIN the batch
   *     (the same name reaching the list twice, e.g. `Foo` and `foo` both
   *     lowercased after grouping) are skipped rather than erroring, because
   *     `DO NOTHING` also sees rows this very command inserted.
   *  2. `returning` says exactly which rows landed, so `rejected` is DERIVED from
   *     the database's answer instead of inferred from an error's shape.
   *  3. If that statement fails for any OTHER reason — a CHECK violation on one
   *     bad measurement — the batch is retried row by row so the damage stays one
   *     trend. That path is the whole reason this function returns rejections
   *     instead of throwing.
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
      type: item.type,
      name: item.name,
      description: item.description,
      score: item.score,
      volume: item.volume,
      momentum: item.momentum,
      rank: index + 1,
      ...(item.topicId ? { topicId: item.topicId } : {}),
      calculatedAt,
      updatedAt: new Date(),
    }));

    const db = getDb();
    /**
     * The rows that did NOT land, one entry per rejected ROW — a multiset
     * difference, not a set one. Two rows in a batch can carry the same
     * `(name, type)` (`Foo` and `foo` both lowercase to one name after the
     * hashtag grouping), one of them lands, and the other is still a measurement
     * that was dropped. Comparing sets would report it as fully accepted, which
     * is the quiet partial-batch the caller's error log exists to prevent.
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
  ): Promise<{ trending: TrendWithSeries[]; summary: string; recId?: string }> {
    const cacheKey = `trending:latest:${limit}:${type || 'all'}`;
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
      .limit(limit);

    const serialized = rows.map(serializeTrend);

    // Only reached on a cache MISS. The entry below is warmed right after each
    // recalculation (see warmDefaultCache), so this aggregation runs on the order
    // of once per 30-minute batch per requested shape — not once per reader.
    const series = await this.loadVolumeSeries(serialized);

    const result = {
      trending: serialized.map((trend): TrendWithSeries => {
        const points = series.get(trendKey(trend.name, trend.type));
        return points ? { ...trend, series: points } : trend;
      }),
      summary: latestBatch.summary,
      recId: mintTrendRecId(latestBatch.calculatedAt),
    };

    if (redis && rows.length > 0) {
      try {
        await redis.setEx(cacheKey, this.REDIS_CACHE_TTL, JSON.stringify(result));
      } catch (cacheError) {
        logger.warn('[Trending] Redis cache write failed:', cacheError);
      }
    }

    return result;
  }

  /**
   * Recent `volume` history for the given trends, keyed by {@link trendKey}.
   *
   * The `Trending` collection is the ONLY per-(name, type) time series that
   * exists: the job appends a full batch every 30 minutes and keeps 90 days, and
   * the unique `{ name: 1, calculatedAt: 1, type: 1 }` index serves this range
   * scan directly. (The obvious-looking alternative, `TopicStats`, holds one
   * current-value row per topic and no history whatsoever.) The `$sort` uses that
   * index's exact key order, so the planner can stream straight into `$group` —
   * `$push` accumulates in arrival order, which is what puts each series' volumes
   * in time order.
   *
   * Keyed on (name, type), NOT on name. A name that trends as both a hashtag and
   * a classified topic is two independent measurements of two different things;
   * grouping them under the name alone would interleave them into one array and
   * draw a sparkline that zig-zags between two unrelated quantities.
   *
   * A name absent from a batch contributes NO point rather than a zero: it means
   * the trend fell out of the window that batch, and only for hashtags does that
   * strictly imply zero posts (topics need two). Guessing which would be exactly
   * the kind of invented data this feature exists to avoid, so short runs are
   * simply dropped by the floor in {@link buildTrendSeries}.
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
    trends: Array<Pick<SerializedTrend, 'name' | 'type'>>,
  ): Promise<Map<string, number[]>> {
    const byTrend = new Map<string, number[]>();
    if (trends.length === 0) return byTrend;

    // The `where` narrows on name alone (the unique index's leading field); the
    // group then splits each name back into its per-type series.
    const names = [...new Set(trends.map((trend) => trend.name))];

    try {
      const cutoff = new Date(Date.now() - MtnConfig.trending.series.windowMs);
      /**
       * `array_agg(volume order by calculated_at)` replaces Mongo's
       * `$sort` + `$push`, and it is the stronger spelling: Mongo's array was in
       * time order only because the planner happened to stream the matching index
       * in that order, whereas the ordered aggregate STATES it. The ordering is
       * total inside a group — `(name, calculated_at, type)` is unique, so one
       * (name, type) pair cannot have two rows at the same instant.
       */
      const rows = await getDb()
        .select({
          name: trending.name,
          type: trending.type,
          volumes: sql<number[]>`array_agg(${trending.volume} order by ${trending.calculatedAt} asc)`,
        })
        .from(trending)
        .where(and(inArray(trending.name, names), gte(trending.calculatedAt, cutoff)))
        .groupBy(trending.name, trending.type);

      for (const row of rows) {
        const series = buildTrendSeries(row.volumes);
        if (series) byTrend.set(trendKey(row.name, row.type), series);
      }
    } catch (error) {
      logger.warn('[Trending] Volume series lookup failed:', error);
    }

    return byTrend;
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
   * Both queries are WINDOWED on `calculated_at >= cutoff` (now − retention
   * window), so the planner narrows the scan through `trending_calculated_at_idx`
   * — the same index the expiry sweep needs — instead of scanning the whole
   * (previously unbounded) table. The result is cached in Redis per `page:limit`
   * with a short TTL so repeat loads are cache reads. Both the window and the
   * cache are fail-soft.
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
   * prevent unbounded growth.
   *
   * `trending` also has a registry entry in `db/expiry.ts` — the replacement for
   * its Mongo TTL index — so this delete is redundant for that table. It is
   * retained because `trend_batches` has NO expiry entry and this is the only
   * thing keeping it bounded. Both are cleaned to the SAME cutoff so trend
   * batches and their trends expire together, and `getTrending` can never read a
   * batch whose rows have been reaped.
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
