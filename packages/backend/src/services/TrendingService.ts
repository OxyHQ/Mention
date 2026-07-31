import { Post } from '../models/Post';
import Trending, { TrendingType, ITrending, TRENDING_TTL_SECONDS } from '../models/Trending';
import { PostVisibility } from '@mention/shared-types';
import { TopicType } from '@oxyhq/core';
import TrendBatch from '../models/TrendBatch';
import { logger } from '../utils/logger';
import { getRedisClient } from '../utils/redis';
import { emitTrendsUpdated } from '../utils/socket';
import { aliaChat, isAliaEnabled } from '../utils/alia';
import { topicService } from './TopicService';
import { isNsfwHashtag } from './contentClassification/nsfw';
// Trending shares the SINGLE canonical sensitive-exclusion clause with every
// feed (For You, Explore, ranking). Adding a new gate updates trending too.
import { SENSITIVE_EXCLUDE_MATCH } from '../mtn/feed/feedSafety';
import { mintTrendRecId } from './trending/trendTelemetry';
<<<<<<< HEAD
import { buildTrendSeries } from './trending/trendSeries';
import { metrics } from '../utils/metrics';
=======
>>>>>>> eb94101b (chore: sync latest frontend/backend changes)

/**
 * How long the current batch's `recId` is memoized in process. Far shorter than
 * the 30-minute batch interval so a rotation is picked up almost immediately,
 * long enough that a burst of reported presses costs at most one Mongo read.
 */
const CURRENT_REC_ID_TTL_MS = 30_000;

interface TrendItem {
  type: TrendingType;
  name: string;
  description: string;
  score: number;
  volume: number;
  momentum: number;
  topicId?: string;
}

<<<<<<< HEAD
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
function trendKey(name: string, type: TrendingType): string {
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
export type TrendWithSeries = TrendingRecord & { series?: number[] };

=======
>>>>>>> eb94101b (chore: sync latest frontend/backend changes)
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
  // Manual-cleanup window, DERIVED from the Trending TTL so the two retention
  // bounds can never drift (previously a hardcoded 30 days — more aggressive than
  // the 90-day TTL/history window, which silently capped visible history at 30d).
  private readonly CLEANUP_DAYS = TRENDING_TTL_SECONDS / (24 * 60 * 60); // 90 days
  // Default `limit` for the public trending list (mirrors the GET /trending
  // route default). Warmed into Redis after each recalculation so the most
  // common request is a cache hit, never a cold aggregate.
  private readonly DEFAULT_TRENDING_LIMIT = 20;
  // History query window, in milliseconds, derived from the collection's TTL
  // retention so the window never asks for data the TTL has already reaped.
  private readonly HISTORY_WINDOW_MS = TRENDING_TTL_SECONDS * 1000;
  // How old the served batch may get before it is reported as stale. Derived from
  // the calculation cadence rather than fixed, so the two can never drift apart.
  // Three cadences: one missed run is a blip (a leader handover, a slow Mongo),
  // three in a row is the job not landing, which is what went unnoticed for a day.
  private readonly STALE_BATCH_AFTER_MS = this.CALCULATION_INTERVAL * 3;

  /**
   * Relevance contributed by a canonical topic ref that carries no `relevance`
   * (AI/rule topics are slug-only). Mid-scale on the 1..10 relevance axis so a
   * slug-only topic counts toward trending without dominating the relevance-aware
   * scoring; matches the neutral "present but unweighted" intent.
   */
  private static readonly DEFAULT_TOPIC_RELEVANCE = 5;

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
      const hashtagTrends = await this.aggregateHashtags();
      const topicTrends = await this.aggregateTopics();

      // Resolve topic names to Topic documents (topics + entities only, not hashtags)
      const topicEntries = topicTrends.map(t => ({
        name: t.name,
        type: t.type === TrendingType.ENTITY ? TopicType.ENTITY : TopicType.TOPIC,
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
      const popularityUpdates = topicTrends
        .filter(t => t.topicId)
        .map(t => ({ topicId: t.topicId!, trendingScore: t.score }));

      // Run AI summary generation, trend persistence, and popularity updates in parallel
      const [summary, write] = await Promise.all([
        this.generateSummary([...topTopicNames, ...topHashtagNames]),
        this.saveTrendingBatch(allTrends, calculatedAt),
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

      await TrendBatch.create({ calculatedAt, summary });

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
   * Aggregate trending hashtags from recent posts in a single pipeline.
   */
  private async aggregateHashtags(): Promise<TrendItem[]> {
    const now = new Date();
    const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const sixHoursAgo = new Date(now.getTime() - 6 * 60 * 60 * 1000);

    const hashtagCounts = await Post.aggregate([
      {
        $match: {
          createdAt: { $gte: oneDayAgo },
          hashtags: { $exists: true, $ne: [] },
          status: 'published',
          visibility: PostVisibility.PUBLIC,
          boostOf: { $exists: false },
          // Sensitive/NSFW-flagged posts never feed trending counts.
          ...SENSITIVE_EXCLUDE_MATCH,
        },
      },
      { $unwind: '$hashtags' },
      {
        $group: {
          _id: '$hashtags',
          count24h: { $sum: 1 },
          count6h: {
            $sum: { $cond: [{ $gte: ['$createdAt', sixHoursAgo] }, 1, 0] },
          },
        },
      },
    ]);

    const trends: TrendItem[] = hashtagCounts
      // Drop blocklisted NSFW/adult hashtags even if they appear on
      // non-sensitive posts (case-insensitive, normalized in isNsfwHashtag).
      .filter(item => !isNsfwHashtag(item._id))
      .map(item => {
        const hashtagName = item._id.toLowerCase();
        const volume24h = item.count24h;
        const volume6h = item.count6h;

        const momentum = volume24h > 0 ? (volume6h * 4) / volume24h : 0;
        const score = volume24h * (1 + momentum * 0.5);

        return {
          type: TrendingType.HASHTAG,
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
   */
  private async aggregateTopics(): Promise<TrendItem[]> {
    const now = new Date();
    const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const sixHoursAgo = new Date(now.getTime() - 6 * 60 * 60 * 1000);

    const topicCounts = await Post.aggregate([
      {
        $match: {
          createdAt: { $gte: oneDayAgo },
          status: 'published',
          visibility: PostVisibility.PUBLIC,
          boostOf: { $exists: false },
          // At least one topic source must be present.
          $or: [
            { 'postClassification.topicRefs': { $exists: true, $ne: [] } },
            { 'postClassification.topics': { $exists: true, $ne: [] } },
          ],
          // Sensitive/NSFW-flagged posts never feed trending topics.
          ...SENSITIVE_EXCLUDE_MATCH,
        },
      },
      {
        // Prefer the canonical topicRefs; fall back to the slug-only
        // `postClassification.topics`, mapping each slug string to a `{ name }`
        // shape so the downstream unwind/group reads `name` uniformly. `$ifNull`
        // returns the first non-null operand, and the size guard makes an empty
        // topicRefs array fall through to the slug list.
        $addFields: {
          _topicSource: {
            $cond: [
              { $gt: [{ $size: { $ifNull: ['$postClassification.topicRefs', []] } }, 0] },
              '$postClassification.topicRefs',
              {
                $map: {
                  input: { $ifNull: ['$postClassification.topics', []] },
                  as: 'name',
                  in: { name: '$$name' },
                },
              },
            ],
          },
        },
      },
      { $unwind: '$_topicSource' },
      {
        $group: {
          _id: {
            name: '$_topicSource.name',
            // Canonical refs may omit `type`; default to 'topic' (never entity).
            type: { $ifNull: ['$_topicSource.type', 'topic'] },
          },
          // Canonical refs may omit `relevance`; default to a neutral value so a
          // slug-only topic still contributes to the trending volume/score.
          totalRelevance: {
            $sum: { $ifNull: ['$_topicSource.relevance', TrendingService.DEFAULT_TOPIC_RELEVANCE] },
          },
          postCount: { $sum: 1 },
          recentCount: {
            $sum: { $cond: [{ $gte: ['$createdAt', sixHoursAgo] }, 1, 0] },
          },
        },
      },
      {
        $match: { postCount: { $gte: 2 } },
      },
    ]);

    const trends: TrendItem[] = topicCounts
      // Drop blocklisted NSFW/adult topic slugs from trending topics.
      .filter(item => !isNsfwHashtag(item._id.name))
      .map(item => {
        const momentum = item.postCount > 0
          ? Math.min((item.recentCount * 4) / item.postCount, 1)
          : 0;
        const score = item.totalRelevance * (1 + momentum * 0.5);

        return {
          type: item._id.type === 'topic' ? TrendingType.TOPIC : TrendingType.ENTITY,
          name: item._id.name,
          description: '',
          score,
          volume: item.postCount,
          momentum,
        };
      });

    trends.sort((a, b) => b.score - a.score);
    return trends.slice(0, 15);
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

    const docs = sorted.map((item, index) => ({
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

    try {
      const inserted = await Trending.insertMany(docs, { ordered: false });
      logger.debug(`[Trending] Saved ${inserted.length} trends for batch ${calculatedAt.toISOString()}`);
      return { insertedCount: inserted.length, rejected: [] };
    } catch (error) {
      // An unordered bulk write reports per-document failures on the error rather
      // than the result, with `index` addressing the position in `docs`. Anything
      // that is NOT a per-document report (a connection loss, an auth failure) has
      // no partial outcome to salvage and must keep propagating.
      const writeErrors = (error as { writeErrors?: unknown }).writeErrors;
      if (!Array.isArray(writeErrors)) throw error;

      const rejected = writeErrors.map((writeError) => {
        const index = (writeError as { index?: number }).index;
        const doc = typeof index === 'number' ? docs[index] : undefined;
        return doc ? trendKey(doc.name, doc.type) : 'unknown';
      });
      return { insertedCount: docs.length - writeErrors.length, rejected };
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
  ): Promise<{ trending: ITrending[]; summary: string; recId?: string }> {
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

    // Use TrendBatch to find the latest timestamp and summary in one query
    const latestBatch = await TrendBatch.findOne()
      .sort({ calculatedAt: -1 })
      .lean();

    if (!latestBatch) return { trending: [], summary: '' };

    this.observeBatchAge(latestBatch.calculatedAt);

    const query: Record<string, unknown> = {
      calculatedAt: latestBatch.calculatedAt,
    };
    if (type) query.type = type;

    const trending = await Trending.find(query)
      .sort({ score: -1, rank: 1 })
      .limit(limit)
<<<<<<< HEAD
      .lean() as unknown as TrendingRecord[];

    // Only reached on a cache MISS. The entry below is warmed right after each
    // recalculation (see warmDefaultCache), so this aggregation runs on the order
    // of once per 30-minute batch per requested shape — not once per reader.
    const series = await this.loadVolumeSeries(trending);

    const result = {
      trending: trending.map((trend): TrendWithSeries => {
        const points = series.get(trendKey(trend.name, trend.type));
        return points ? { ...trend, series: points } : trend;
      }),
=======
      .lean() as unknown as ITrending[];

    const result = {
      trending,
>>>>>>> eb94101b (chore: sync latest frontend/backend changes)
      summary: latestBatch.summary || '',
      recId: mintTrendRecId(latestBatch.calculatedAt),
    };

    if (redis && trending.length > 0) {
      try {
        await redis.setEx(cacheKey, this.REDIS_CACHE_TTL, JSON.stringify(result));
      } catch (cacheError) {
        logger.warn('[Trending] Redis cache write failed:', cacheError);
      }
    }

    return result;
  }

  /**
<<<<<<< HEAD
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
    trends: Array<Pick<TrendingRecord, 'name' | 'type'>>,
  ): Promise<Map<string, number[]>> {
    const byTrend = new Map<string, number[]>();
    if (trends.length === 0) return byTrend;

    // The `$match` narrows on name alone (the index's leading field); the group
    // then splits each name back into its per-type series.
    const names = [...new Set(trends.map((trend) => trend.name))];

    try {
      const cutoff = new Date(Date.now() - MtnConfig.trending.series.windowMs);
      const rows = await Trending.aggregate<{
        _id: { name: string; type: TrendingType };
        volumes: number[];
      }>([
        { $match: { name: { $in: names }, calculatedAt: { $gte: cutoff } } },
        { $sort: { name: 1, calculatedAt: 1, type: 1 } },
        { $group: { _id: { name: '$name', type: '$type' }, volumes: { $push: '$volume' } } },
      ]);

      for (const row of rows) {
        const series = buildTrendSeries(row.volumes);
        if (series) byTrend.set(trendKey(row._id.name, row._id.type), series);
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
=======
>>>>>>> eb94101b (chore: sync latest frontend/backend changes)
   * The `recId` of the batch that is current RIGHT NOW — what a submitted token
   * is compared against to derive the bounded `freshness` label.
   *
   * Memoized in process for {@link CURRENT_REC_ID_TTL_MS} because this is read on
   * the telemetry hot path, where a Mongo round trip per reported press would
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
      const latestBatch = await TrendBatch.findOne()
        .sort({ calculatedAt: -1 })
        .select({ calculatedAt: 1 })
        .lean();
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
   * Both aggregations are WINDOWED: their first stage matches
   * `calculatedAt >= cutoff` (now − retention window) so MongoDB narrows the
   * scan through the `{ calculatedAt: 1 }` index instead of grouping the entire
   * (previously unbounded) collection. The result is cached in Redis per
   * `page:limit` with a short TTL so repeat loads are cache reads. Both the
   * window and the cache are fail-soft.
   */
  public async getTrendingHistory(
    page: number = 1,
    limit: number = 10,
  ): Promise<{ days: Array<{ date: string; trends: ITrending[] }>; page: number; totalPages: number }> {
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

    // Get distinct days within the window.
    const allDays = await Trending.aggregate<{ _id: string }>([
      { $match: { calculatedAt: { $gte: cutoff } } },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$calculatedAt' } },
        },
      },
      { $sort: { _id: -1 } },
    ]);

    const totalPages = Math.ceil(allDays.length / limit);
    const start = (page - 1) * limit;
    const pageDays = allDays.slice(start, start + limit).map((d) => d._id);

    if (pageDays.length === 0) {
      return { days: [], page, totalPages };
    }

    // For each day, get unique trends with highest score. The leading
    // `$match` on `calculatedAt` lets the planner use the index before the
    // day-string derivation and `$in` filter.
    const grouped = await Trending.aggregate<{ date: string; trends: ITrending[] }>([
      { $match: { calculatedAt: { $gte: cutoff } } },
      {
        $addFields: {
          day: { $dateToString: { format: '%Y-%m-%d', date: '$calculatedAt' } },
        },
      },
      { $match: { day: { $in: pageDays } } },
      { $sort: { score: -1 } },
      {
        $group: {
          _id: { day: '$day', name: '$name', type: '$type' },
          doc: { $first: '$$ROOT' },
        },
      },
      { $replaceRoot: { newRoot: '$doc' } },
      { $sort: { day: -1, score: -1 } },
      {
        $group: {
          _id: '$day',
          trends: { $push: '$$ROOT' },
        },
      },
      {
        $project: {
          date: '$_id',
          trends: { $slice: ['$trends', 20] },
        },
      },
      { $sort: { date: -1 } },
    ]);

    const days = grouped.map((g) => ({
      date: g.date,
      trends: g.trends,
    }));

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
   * Remove trends older than CLEANUP_DAYS (= the 90-day TTL window) to prevent
   * unbounded growth. The `Trending` collection also has a TTL index that reaps
   * it at the storage layer, so this manual delete is redundant for `Trending`;
   * it is retained because `TrendBatch` has NO TTL index and this is the only
   * thing that keeps it bounded. Both are cleaned to the SAME cutoff so trend
   * batches and their trends expire together.
   */
  private async cleanupOldTrends(): Promise<void> {
    try {
      const cutoff = new Date(Date.now() - this.CLEANUP_DAYS * 24 * 60 * 60 * 1000);
      const result = await Trending.deleteMany({ calculatedAt: { $lt: cutoff } });
      await TrendBatch.deleteMany({ calculatedAt: { $lt: cutoff } });

      if (result.deletedCount > 0) {
        logger.info(`[Trending] Cleaned up ${result.deletedCount} trends older than ${this.CLEANUP_DAYS} days`);
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
