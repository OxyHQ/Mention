/**
 * One-shot corpus backfill for the EXPAND phase of the boost -> repost rename:
 * copy the old columns of `posts` into their new twins for every row written
 * before migration 0126.
 *
 * `posts_sync_repost_columns` keeps each pair equal for every row written from
 * then on; this brings the rows that predate it level (`boost_of` ->
 * `repost_of`, `stats_boosts_count` -> `stats_reposts_count`,
 * `stats_federated_boosts_count` -> `stats_federated_reposts_count`,
 * `metadata_is_boosted` -> `metadata_is_reposted`). It touches only rows whose
 * pair differs, in short transactions of `--batch` rows ordered by id, so it
 * never holds a lock for long and a re-run over a finished corpus writes nothing.
 * The trigger fires on these updates too, and finds the pair already equal.
 *
 * Runnable as a Fargate one-shot after the deploy that carries 0126:
 *   bun packages/backend/dist/src/scripts/backfillRepostColumns.js --dry-run
 *   CONFIRM_ADMIN_MUTATION=backfillRepostColumns bun packages/backend/dist/src/scripts/backfillRepostColumns.js
 */

import { sql } from 'drizzle-orm';
import { connectPostgres, getDb } from '../db/postgres';
import { logger } from '../utils/logger';
import { closeAdminScriptResources } from './lib/adminScriptLifecycle';
import { assertAdminMutationAllowed } from './lib/adminScriptSafety';

/** Rows copied per transaction. */
const DEFAULT_BATCH_SIZE = 2000;

/**
 * Rest between batches. The corpus is millions of rows on a database every app
 * shares, and each update writes a new row version plus an entry in every index of
 * `posts`; resting keeps the load a trickle that autovacuum and the replicas keep
 * up with, at the price of a longer run (the script is resumable, so that is cheap).
 */
const DEFAULT_PAUSE_MS = 250;

/** A pair that differs: the row still needs the copy. */
const PAIR_DIFFERS = sql`(
  repost_of is distinct from boost_of
  or stats_reposts_count <> stats_boosts_count
  or stats_federated_reposts_count <> stats_federated_boosts_count
  or metadata_is_reposted <> metadata_is_boosted
)`;

export interface BackfillRepostColumnsResult {
  batches: number;
  updated: number;
}

/** Copy the old columns into the new ones. The caller owns the connection. */
export async function backfillRepostColumns(
  opts: {
    batchSize?: number;
    dryRun?: boolean;
    postIds?: readonly string[];
    pauseMs?: number;
  } = {},
): Promise<BackfillRepostColumnsResult> {
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
  const dryRun = opts.dryRun ?? false;
  const pauseMs = opts.pauseMs ?? DEFAULT_PAUSE_MS;
  const db = getDb();
  const scope = opts.postIds
    ? sql`and id in (${sql.join(
        opts.postIds.map((id) => sql`${id}`),
        sql`, `,
      )})`
    : sql``;

  let cursor = '';
  let batches = 0;
  let updated = 0;
  for (;;) {
    // The ids of the next page of rows that still differ, by primary key.
    const page = await db.execute<{ id: string }>(sql`
      select id from posts
      where id > ${cursor} and ${PAIR_DIFFERS} ${scope}
      order by id
      limit ${batchSize}
    `);
    if (page.length === 0) break;
    const ids = page.map((row) => row.id);
    cursor = ids[ids.length - 1];
    batches += 1;
    updated += ids.length;
    if (dryRun) continue;

    await db.execute(sql`
      update posts
      set repost_of = boost_of,
          stats_reposts_count = stats_boosts_count,
          stats_federated_reposts_count = stats_federated_boosts_count,
          metadata_is_reposted = metadata_is_boosted
      where id in (${sql.join(
        ids.map((id) => sql`${id}`),
        sql`, `,
      )})
    `);
    if (pauseMs > 0) await new Promise((resolve) => setTimeout(resolve, pauseMs));
    if (batches % 25 === 0) {
      logger.info(`[backfillRepostColumns] progress: ${batches} batches, ${updated} rows`);
    }
  }
  return { batches, updated };
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  try {
    assertAdminMutationAllowed({ scriptName: 'backfillRepostColumns', dryRun });
    await connectPostgres();
    const result = await backfillRepostColumns({ dryRun });
    logger.info(
      `[backfillRepostColumns] done${dryRun ? ' (DRY_RUN, nothing written)' : ''}: ${result.updated} rows in ${result.batches} batches`,
    );
  } catch (error) {
    logger.error('[backfillRepostColumns] failed', error);
    throw error;
  } finally {
    await closeAdminScriptResources();
  }
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}
