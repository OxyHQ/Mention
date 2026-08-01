/**
 * Post-rollout reconciliation for the two engagement projections whose legacy
 * writers did not maintain them: `posts.stats_saves_count` and
 * `post_recent_repliers`.
 *
 * Each batch re-derives the projection from the AUTHORITATIVE rows inside one
 * bounded transaction. New engagement writers touch the same post/projection
 * rows, so a concurrent write either serializes after the repair or forces its
 * transaction to retry against fresh data — a stale read can never clobber a
 * live one.
 *
 * ## The saves repair is one statement, not an aggregate plus a bulk write
 *
 * Mongo had to `$group` bookmarks in the application and then send back a
 * `bulkWrite` of per-post `$set`s, because it could not join. Here the count IS
 * the assignment. The correlated reference is written with `qualified()` on BOTH
 * sides, which is not decoration: a drizzle column interpolated into `sql`
 * renders BARE when its table is not in that statement's `FROM`, so
 * `where ${bookmarks.postId} = ${posts.id}` would render `where "post_id" = "id"`,
 * resolve both names against the SUBQUERY's own table, compare two of its columns
 * to each other and return zero — silently, with no error. That shipped in the
 * sibling oxy-api port and read as "nobody has any followers".
 *
 * ## The replier repair delegates rather than re-deriving
 *
 * `PostRecentReplierService.recomputeRecentRepliers` is the single definition of
 * "the authoritative ≤3". Mongo carried a second copy of that aggregation here,
 * which is how a repair drifts from the thing it repairs.
 *
 * ## Candidates are paged by keyset, never collected
 *
 * Every candidate query can name a large fraction of the table, so the ids are
 * walked `id > lastId` a batch at a time rather than materialized. Keyset is
 * also the only correct cursor here: the saves pass repairs the very predicate
 * it selects on (`stats_saves_count > 0`), so an OFFSET would skip rows as the
 * result set shrinks underneath it, while moving forward on the primary key
 * cannot.
 */

import { and, asc, gt, inArray, isNotNull, sql } from 'drizzle-orm';
import { qualified } from '../db/casing';
import { getDb, type Transaction } from '../db/postgres';
import {
  DEADLOCK_DETECTED,
  SERIALIZATION_FAILURE,
  isUniqueViolation,
  sqlStateOf,
} from '../db/pgErrors';
import { bookmarks } from '../db/schema/engagement';
import { postRecentRepliers } from '../db/schema/postContent';
import { posts } from '../db/schema/posts';
import {
  ELIGIBLE_REPLY_MATCH,
  recomputeRecentRepliers,
} from './PostRecentReplierService';
import { logger } from '../utils/logger';

/** Posts repaired per transaction. Bounded so one sweep cannot hold a long transaction open. */
const RECONCILIATION_BATCH_SIZE = 100;
const MAX_TRANSACTION_ATTEMPTS = 3;

export interface EngagementProjectionReconciliationResult {
  saveBatches: number;
  recentReplierBatches: number;
}

/** One page of candidate ids, strictly after `afterId` in primary-key order. */
type CandidatePage = (afterId: string | null) => Promise<string[]>;

/**
 * The concurrency outcomes a fresh transaction resolves.
 *
 * `sqlStateOf` walks drizzle's wrapper to the driver error underneath — reading
 * `error.code` directly matches nothing, because the SQLSTATE lives on `cause`.
 * A unique violation counts because a concurrent reply writer can insert the
 * projection row between this transaction's delete and its insert.
 */
function isRetryableTransactionError(error: unknown): boolean {
  if (isUniqueViolation(error)) return true;
  const sqlState = sqlStateOf(error);
  return sqlState === SERIALIZATION_FAILURE || sqlState === DEADLOCK_DETECTED;
}

async function runTransactionWithRetry(
  work: (tx: Transaction) => Promise<void>,
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_TRANSACTION_ATTEMPTS; attempt += 1) {
    try {
      await getDb().transaction(work);
      return;
    } catch (error) {
      lastError = error;
      if (
        attempt === MAX_TRANSACTION_ATTEMPTS ||
        !isRetryableTransactionError(error)
      ) {
        throw error;
      }
    }
  }
  throw lastError;
}

/**
 * Set each post's `stats_saves_count` to the number of bookmarks that actually
 * reference it — zero included, which is what repairs a counter a legacy writer
 * left standing after its last bookmark was removed.
 */
async function reconcileSaveBatch(postIds: readonly string[]): Promise<void> {
  await runTransactionWithRetry(async (tx) => {
    await tx
      .update(posts)
      .set({
        statsSavesCount: sql`(
          select count(*)::int from ${bookmarks}
          where ${qualified(bookmarks.postId)} = ${qualified(posts.id)}
        )`,
      })
      // `inArray`, never `= any(${jsArray})`: a raw JS array interpolated into a
      // `sql` template binds as a ROW constructor, which Postgres rejects.
      .where(inArray(posts.id, [...postIds]));
  });
}

async function reconcileRecentReplierBatch(postIds: readonly string[]): Promise<void> {
  await runTransactionWithRetry(async (tx) => {
    for (const postId of postIds) {
      await recomputeRecentRepliers(postId, tx);
    }
  });
}

/**
 * Neither `reconcile` below is guarded against an empty batch, and does not need
 * to be: the loop returns before calling it. An unreachable guard is a branch
 * that can only ever be wrong about why it exists.
 */
async function processCandidatePages(
  page: CandidatePage,
  reconcile: (batch: readonly string[]) => Promise<void>,
): Promise<number> {
  let batches = 0;
  let afterId: string | null = null;
  for (;;) {
    const ids = await page(afterId);
    if (ids.length === 0) return batches;
    await reconcile(ids);
    batches += 1;
    // A short page is the last page, which is also what makes the index below
    // safe: reaching it means the page was FULL, so it has a last element.
    if (ids.length < RECONCILIATION_BATCH_SIZE) return batches;
    afterId = ids[ids.length - 1];
  }
}

/** A positive counter that may no longer be earned by any bookmark. */
const staleSaveCountPage: CandidatePage = async (afterId) => {
  const rows = await getDb()
    .select({ id: posts.id })
    .from(posts)
    .where(
      and(
        gt(posts.statsSavesCount, 0),
        afterId === null ? undefined : gt(posts.id, afterId),
      ),
    )
    .orderBy(asc(posts.id))
    .limit(RECONCILIATION_BATCH_SIZE);
  return rows.map((row) => row.id);
};

/**
 * Every post an authoritative bookmark points at, including posts a legacy
 * writer never counted at all. Overlaps the page above; reconciling a post twice
 * is idempotent, and covering both is what the two passes are for.
 */
const bookmarkedPostPage: CandidatePage = async (afterId) => {
  const rows = await getDb()
    .selectDistinct({ id: bookmarks.postId })
    .from(bookmarks)
    .where(afterId === null ? undefined : gt(bookmarks.postId, afterId))
    .orderBy(asc(bookmarks.postId))
    .limit(RECONCILIATION_BATCH_SIZE);
  return rows.map((row) => row.id);
};

/** Existing projection rows — they cover stale entries and deleted replies. */
const projectedParentPage: CandidatePage = async (afterId) => {
  const rows = await getDb()
    .selectDistinct({ id: postRecentRepliers.postId })
    .from(postRecentRepliers)
    .where(afterId === null ? undefined : gt(postRecentRepliers.postId, afterId))
    .orderBy(asc(postRecentRepliers.postId))
    .limit(RECONCILIATION_BATCH_SIZE);
  return rows.map((row) => row.id);
};

/** The authoritative parent list — it covers parents no writer ever projected. */
const repliedToParentPage: CandidatePage = async (afterId) => {
  const rows = await getDb()
    .selectDistinct({ id: posts.parentPostId })
    .from(posts)
    .where(
      and(
        isNotNull(posts.parentPostId),
        ELIGIBLE_REPLY_MATCH,
        afterId === null ? undefined : gt(posts.parentPostId, afterId),
      ),
    )
    .orderBy(asc(posts.parentPostId))
    .limit(RECONCILIATION_BATCH_SIZE);
  return rows.flatMap((row) => (row.id === null ? [] : [row.id]));
};

export async function reconcileEngagementProjections(): Promise<EngagementProjectionReconciliationResult> {
  let saveBatches = 0;
  let recentReplierBatches = 0;

  saveBatches += await processCandidatePages(staleSaveCountPage, reconcileSaveBatch);
  saveBatches += await processCandidatePages(bookmarkedPostPage, reconcileSaveBatch);

  recentReplierBatches += await processCandidatePages(
    projectedParentPage,
    reconcileRecentReplierBatch,
  );
  recentReplierBatches += await processCandidatePages(
    repliedToParentPage,
    reconcileRecentReplierBatch,
  );

  const result = { saveBatches, recentReplierBatches };
  logger.info('[EngagementProjectionReconciliation] complete', result);
  return result;
}
