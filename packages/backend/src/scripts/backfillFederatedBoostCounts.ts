/**
 * One-shot corpus backfill: derive `stats.federatedBoostsCount` for posts that
 * predate the counter.
 *
 * `stats.federatedBoostsCount` records how many of a post's boosts originated as
 * inbound ActivityPub Announces (federated boosts) rather than native reposts.
 * Going forward it is maintained in lockstep with `stats.boostsCount` at the
 * federated import site (`OutboxSyncService.importAnnounce`) and the undo site
 * (`InboxProcessingService.handleUndoAnnounce`). Posts boosted before the field
 * existed carry no value (defaulting to 0), so `boostsCount - federatedBoostsCount`
 * would over-count the native boost subset until this runs. This recomputes the
 * exact count from the authoritative boost `Post` records.
 *
 * For each post it counts the boost Posts that reference it (`boostOf === post._id`),
 * are of `type: 'boost'`, and carry a `federation.activityId` (the marker of a
 * federated Announce), then writes that number to `stats.federatedBoostsCount`.
 *
 * Idempotent: the stored value is compared to the freshly computed count and a
 * write is enqueued ONLY when they differ, so a re-run over an already-correct
 * corpus performs zero writes — which is observable on the row itself, since a
 * skipped post keeps its `updated_at`. Batched via a stable ascending `_id` page cursor
 * and bounded bulkWrite chunks. A single post's count failure is isolated so the
 * scan can finish, but the completed run exits non-zero rather than reporting a
 * partial backfill as successful. NOTE the isolation now guards the per-post
 * WRITE: counting became one grouped aggregate per page rather than a COUNT per
 * post, so a counting failure aborts the run instead of being absorbed — which
 * is the correct behaviour for an aggregate covering 500 posts. Supports
 * `--dry-run` (report what it would update, write nothing).
 *
 * Runnable as a Fargate one-shot post-deploy:
 *   bun packages/backend/dist/src/scripts/backfillFederatedBoostCounts.js
 *   bun packages/backend/dist/src/scripts/backfillFederatedBoostCounts.js --dry-run
 */

import { and, asc, count, eq, gt, inArray, isNotNull, type SQL } from 'drizzle-orm';
import { connectPostgres, getDb } from '../db/postgres';
import { posts } from '../db/schema/posts';
import { logger } from '../utils/logger';
import {
  assertAdminRunComplete,
  closeAdminScriptResources,
} from './lib/adminScriptLifecycle';
import { assertAdminMutationAllowed } from './lib/adminScriptSafety';

/** Posts scanned per page (stable ascending `id` cursor pagination). */
const DEFAULT_PAGE_SIZE = 500;

export interface BackfillFederatedBoostCountsResult {
  scanned: number;
  updated: number;
  failed: number;
}

/**
 * Recompute and backfill `stats_federated_boosts_count` across the corpus. The
 * caller owns the connection lifecycle, so this is reusable from an in-process
 * caller.
 */
export async function backfillFederatedBoostCounts(
  opts: { batchSize?: number; dryRun?: boolean; postIds?: readonly string[] } = {},
): Promise<BackfillFederatedBoostCountsResult> {
  const pageSize = opts.batchSize ?? DEFAULT_PAGE_SIZE;
  const dryRun = opts.dryRun ?? false;
  /**
   * Optional scope. The CLI never passes one — a corpus backfill is the point —
   * but a targeted re-run after an incident should not have to walk every post
   * to repair the handful that were reported wrong, and the same scope is what
   * lets this be exercised against real rows in a database shared with other
   * suites without rewriting a column those suites own.
   */
  const scope = opts.postIds && opts.postIds.length > 0 ? [...opts.postIds] : null;

  const db = getDb();
  let scanned = 0;
  let updated = 0;
  let failed = 0;
  let lastId: string | null = null;

  // No selection filter: any post can be a boost target, so every post is a
  // candidate. Posts with no federated boosts compute a count of 0 that matches
  // the stored default, so they are skipped without a write (idempotency). The
  // ascending `id` cursor never revisits a page.
  for (;;) {
    const cursor: SQL | undefined = lastId ? gt(posts.id, lastId) : undefined;
    const page = await db
      .select({ id: posts.id, federatedBoostsCount: posts.statsFederatedBoostsCount })
      .from(posts)
      .where(scope ? and(cursor, inArray(posts.id, scope)) : cursor)
      .orderBy(asc(posts.id))
      .limit(pageSize);

    if (page.length === 0) break;

    // ONE grouped aggregate for the whole page, not one COUNT per post: the
    // Mongo version issued `pageSize` round trips per page, which on a corpus
    // this sweep is designed to walk end to end is the dominant cost.
    //
    // A federated Announce boost is a boost row that references the post AND
    // carries a federation activity id — a native repost has `boost_of` +
    // `type = 'boost'` but NO `federation_activity_id`.
    const pageIds = page.map((row) => row.id);
    const boostRows = await db
      .select({ boostOf: posts.boostOf, count: count() })
      .from(posts)
      .where(and(
        inArray(posts.boostOf, pageIds),
        eq(posts.type, 'boost'),
        isNotNull(posts.federationActivityId),
      ))
      .groupBy(posts.boostOf);
    const federatedBoostsById = new Map(
      boostRows.flatMap((row) => (row.boostOf ? [[row.boostOf, row.count] as const] : [])),
    );

    for (const post of page) {
      scanned += 1;
      try {
        const federatedBoosts = federatedBoostsById.get(post.id) ?? 0;

        // Already correct (the common zero-boost case): skip — keeps re-runs
        // write-free and idempotent.
        if (federatedBoosts === post.federatedBoostsCount) continue;

        updated += 1;
        if (dryRun) continue;

        await db
          .update(posts)
          .set({ statsFederatedBoostsCount: federatedBoosts })
          .where(eq(posts.id, post.id));
      } catch (error) {
        failed += 1;
        logger.warn('[backfillFederatedBoostCounts] write failed for post; skipping', {
          id: post.id,
          reason: error instanceof Error ? error.message : 'unknown',
        });
      }
    }

    lastId = page[page.length - 1].id;
    logger.info(
      `[backfillFederatedBoostCounts] progress: scanned ${scanned}, updated ${updated}, failed ${failed}`,
    );
  }

  return { scanned, updated, failed };
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  const dryRun = process.argv.includes('--dry-run');

  try {
    assertAdminMutationAllowed({
      scriptName: 'backfillFederatedBoostCounts',
      dryRun,
    });
    await connectPostgres();
    logger.info('[backfillFederatedBoostCounts] connected to PostgreSQL', { dryRun });

    const result = await backfillFederatedBoostCounts({ dryRun });

    const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
    logger.info(
      `[backfillFederatedBoostCounts] done${dryRun ? ' (DRY_RUN — no writes)' : ''}: scanned ${result.scanned}, updated ${result.updated}, failed ${result.failed} (${elapsedSeconds}s)`,
    );

    assertAdminRunComplete('backfillFederatedBoostCounts', {
      failed: result.failed,
    });
  } catch (error) {
    logger.error('[backfillFederatedBoostCounts] failed', error);
    throw error;
  } finally {
    await closeAdminScriptResources();
  }
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      logger.error('[backfillFederatedBoostCounts] unhandled failure', error);
      process.exit(1);
    });
}
