/**
 * One-shot backfill: copy `posts.created_at` onto every rendition that lacks it
 * (`post_content_variants.post_created_at`), then build the index the posts
 * search bounds its text match with (#1158).
 *
 * `drizzle/0048_variant_post_created_at.sql` adds the column and nothing else,
 * because the migrator holds the table's ACCESS EXCLUSIVE lock until it commits
 * and an UPDATE of 1.2M rows there would block every read of every post's text
 * for minutes. New renditions are written with the column set
 * (`postRepository`'s `postCreatedAtSql`); this repairs the rows written before.
 *
 * WHAT IT DOES, in order:
 *
 *  1. Walks `post_content_variants` by primary key in batches of
 *     {@link BATCH_SIZE}, setting `post_created_at` from the post wherever the two
 *     disagree (`IS DISTINCT FROM`, so a NULL and a wrong value are both
 *     repaired and a correct row is never rewritten). Each batch is its own
 *     short statement, and the walk pauses {@link PAUSE_MS} between batches so
 *     autovacuum and the request path keep up on the shared instance.
 *  2. `CREATE INDEX CONCURRENTLY` on the column — online: reads and writes of
 *     the table continue. An INVALID index left by an earlier interrupted build
 *     is dropped (concurrently) and rebuilt, since `IF NOT EXISTS` would
 *     otherwise keep a husk the planner never uses.
 *
 * SAFETY:
 *  1. `DRY_RUN` defaults to `true`: it counts the rows that disagree and writes
 *     nothing.
 *  2. `assertAdminMutationAllowed` refuses a mutating run until the operator
 *     names the script back.
 *  3. Idempotent and cursor-free: a repaired row no longer disagrees, so a run
 *     killed part-way resumes by running it again.
 *  4. Written counts come from what Postgres reports modifying (`returning`).
 *
 * Runnable as a Fargate one-shot (DRY_RUN first):
 *   bun packages/backend/dist/src/scripts/backfillVariantPostCreatedAt.js
 *   DRY_RUN=false CONFIRM_ADMIN_MUTATION=backfillVariantPostCreatedAt \
 *     bun packages/backend/dist/src/scripts/backfillVariantPostCreatedAt.js
 */

import { sql } from 'drizzle-orm';
import { connectPostgres, getDb } from '../db/postgres';
import { logger } from '../utils/logger';
import { closeAdminScriptResources } from './lib/adminScriptLifecycle';
import { assertAdminMutationAllowed } from './lib/adminScriptSafety';

const SCRIPT_NAME = 'backfillVariantPostCreatedAt';

/** Renditions visited per statement. */
const BATCH_SIZE = 2_000;
/** Pause between batches, so the shared instance's other tenants keep their I/O. */
const PAUSE_MS = 50;
/** Batches between progress lines. */
const PROGRESS_EVERY_BATCHES = 50;

/** The index the posts search's time windows intersect with the text index. */
export const VARIANT_POST_CREATED_AT_INDEX = 'post_content_variants_post_created_at_idx';

export interface VariantPostCreatedAtBackfillResult {
  /** Renditions whose copy disagreed with the post when the run started. */
  candidates: number;
  /** Rows Postgres reported modifying. Always 0 on a dry run. */
  written: number;
  /** Whether the index exists and is valid when the run ends. */
  indexValid: boolean;
}

async function countCandidates(): Promise<number> {
  const [row] = await getDb().execute<{ candidates: number }>(sql`
    select count(*)::int as candidates
    from post_content_variants v
    join posts p on p.id = v.post_id
    where v.post_created_at is distinct from p.created_at
  `);
  return Number(row?.candidates ?? 0);
}

async function indexState(): Promise<'valid' | 'invalid' | 'absent'> {
  const [row] = await getDb().execute<{ valid: boolean }>(sql`
    select i.indisvalid as valid
    from pg_index i
    join pg_class c on c.oid = i.indexrelid
    where c.relname = ${VARIANT_POST_CREATED_AT_INDEX}
  `);
  if (!row) return 'absent';
  return row.valid ? 'valid' : 'invalid';
}

/**
 * Build the index online. Outside any transaction: `CONCURRENTLY` refuses to
 * run inside one.
 */
async function ensureIndex(): Promise<boolean> {
  if ((await indexState()) === 'invalid') {
    logger.warn(`[${SCRIPT_NAME}] dropping an invalid index left by an interrupted build`);
    await getDb().execute(sql.raw(`drop index concurrently if exists ${VARIANT_POST_CREATED_AT_INDEX}`));
  }
  await getDb().execute(sql.raw(
    `create index concurrently if not exists ${VARIANT_POST_CREATED_AT_INDEX} ` +
    'on post_content_variants using btree (post_created_at)',
  ));
  return (await indexState()) === 'valid';
}

/** The backfill. The CALLER owns the connection lifecycle, so a test can run it in-process. */
export async function backfillVariantPostCreatedAt(
  opts: { dryRun?: boolean; batchSize?: number; pauseMs?: number } = {},
): Promise<VariantPostCreatedAtBackfillResult> {
  const dryRun = opts.dryRun ?? true;
  const batchSize = opts.batchSize ?? BATCH_SIZE;
  const pauseMs = opts.pauseMs ?? PAUSE_MS;
  const startedAt = Date.now();

  const candidates = await countCandidates();
  const result: VariantPostCreatedAtBackfillResult = {
    candidates,
    written: 0,
    indexValid: (await indexState()) === 'valid',
  };
  logger.info(`[${SCRIPT_NAME}] planned`, { dryRun, candidates, indexValid: result.indexValid });
  if (dryRun) return result;

  // Keyset over the primary key rather than "the next N disagreeing rows": that
  // predicate has no index, so each batch would scan the table to find them.
  let after = '';
  let batches = 0;
  for (;;) {
    const page = await getDb().execute<{ id: string }>(sql`
      select id from post_content_variants
      where id > ${after}
      order by id
      limit ${batchSize}
    `);
    if (page.length === 0) break;
    const last = page[page.length - 1]?.id;
    if (!last) break;

    const updated = await getDb().execute<{ id: string }>(sql`
      update post_content_variants v
      set post_created_at = p.created_at
      from posts p
      where p.id = v.post_id
        and v.id > ${after} and v.id <= ${last}
        and v.post_created_at is distinct from p.created_at
      returning v.id
    `);
    result.written += updated.length;
    after = last;

    batches += 1;
    if (batches % PROGRESS_EVERY_BATCHES === 0) {
      logger.info(`[${SCRIPT_NAME}] progress`, { written: result.written, candidates, after });
    }
    if (pauseMs > 0) await new Promise((resolve) => setTimeout(resolve, pauseMs));
  }

  result.indexValid = await ensureIndex();
  logger.info(`[${SCRIPT_NAME}] complete`, {
    candidates,
    written: result.written,
    remaining: await countCandidates(),
    indexValid: result.indexValid,
    elapsedSec: Math.round((Date.now() - startedAt) / 1000),
  });
  return result;
}

async function main(): Promise<void> {
  const dryRun = (process.env.DRY_RUN ?? 'true') !== 'false';
  assertAdminMutationAllowed({ scriptName: SCRIPT_NAME, dryRun });
  await connectPostgres();
  logger.info(`[${SCRIPT_NAME}] starting`, { dryRun });
  await backfillVariantPostCreatedAt({ dryRun });
}

if (require.main === module) {
  main()
    .then(async () => {
      await closeAdminScriptResources();
      process.exit(0);
    })
    .catch(async (error) => {
      logger.error(`[${SCRIPT_NAME}] failed`, {
        reason: error instanceof Error ? error.message : 'unknown',
      });
      await closeAdminScriptResources().catch(() => undefined);
      process.exit(1);
    });
}
