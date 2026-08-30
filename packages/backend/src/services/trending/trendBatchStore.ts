/**
 * PERSISTENCE for a trend batch: the append-only write, and the sweep that
 * keeps the two trend tables bounded.
 *
 * The write is deliberately partial-tolerant and reports what it refused, so a
 * single bad row costs one trend rather than the whole feature — see
 * {@link saveTrendingBatch}. Nothing here decides what a trend IS; it only
 * decides what landed.
 */

import { lt } from 'drizzle-orm';
import { getDb } from '../../db/postgres';
import {
  TRENDING_RETENTION_SECONDS,
  trendBatches,
  trending,
} from '../../db/schema/discovery';
import { logger } from '../../utils/logger';
import type { TrendItem } from './trendItems';
import type { TrendingKind } from './trendRow';

// Manual-cleanup window, DERIVED from the `trending` retention constant so the
// two bounds can never drift (previously a hardcoded 30 days — more aggressive
// than the 90-day retention/history window, which silently capped visible
// history at 30d).
const CLEANUP_DAYS = TRENDING_RETENTION_SECONDS / (24 * 60 * 60); // 90 days

/**
 * What the database actually accepted for a batch. Returned rather than thrown so
 * a single rejected row degrades one trend instead of the whole batch — see
 * {@link saveTrendingBatch}.
 */
export interface TrendingBatchWrite {
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
export async function saveTrendingBatch(
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
export async function cleanupOldTrends(): Promise<void> {
  try {
    const cutoff = new Date(Date.now() - CLEANUP_DAYS * 24 * 60 * 60 * 1000);
    const db = getDb();
    const deleted = await db
      .delete(trending)
      .where(lt(trending.calculatedAt, cutoff))
      .returning({ id: trending.id });
    await db.delete(trendBatches).where(lt(trendBatches.calculatedAt, cutoff));

    if (deleted.length > 0) {
      logger.info(`[Trending] Cleaned up ${deleted.length} trends older than ${CLEANUP_DAYS} days`);
    }
  } catch (error) {
    logger.warn('[Trending] Cleanup failed:', error);
  }
}
