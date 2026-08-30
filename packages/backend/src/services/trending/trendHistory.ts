/**
 * The trending ARCHIVE — what trended on days past, grouped by UTC day.
 *
 * Deliberately not the live list with a different filter. An archive answers a
 * different question, so it collapses each day's ~48 batches to one row per
 * trend, carries no sparkline and no `recId` (an archive is not a
 * recommendation), and is cached on a short TTL of its own.
 */

import { and, desc, eq, getTableColumns, gte, inArray, lte, sql } from 'drizzle-orm';
import { getDb } from '../../db/postgres';
import { TRENDING_RETENTION_SECONDS, trending } from '../../db/schema/discovery';
import { logger } from '../../utils/logger';
import { getRedisClient } from '../../utils/redis';
import { serializeTrend, type SerializedTrend } from './trendRow';

/** How many trends one archived day carries in `GET /trending/history`. */
const HISTORY_TRENDS_PER_DAY = 20;

// History changes only every 30 minutes (each calculation batch), so a short
// TTL is safe and makes repeat loads of the Explore "Trending" history tab
// cache reads instead of re-running the day-grouping aggregation.
const REDIS_HISTORY_CACHE_TTL = 300; // 5 minutes in seconds

// History query window, in milliseconds, derived from the table's retention so
// the window never asks for data the expiry sweep has already reaped.
const HISTORY_WINDOW_MS = TRENDING_RETENTION_SECONDS * 1000;

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
export async function getTrendingHistory(
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
  const cutoff = new Date(Date.now() - HISTORY_WINDOW_MS);
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
      await redis.setEx(cacheKey, REDIS_HISTORY_CACHE_TTL, JSON.stringify(result));
    } catch (cacheError) {
      logger.warn('[Trending] Redis history cache write failed:', cacheError);
    }
  }

  return result;
}
