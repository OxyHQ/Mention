/**
 * One-shot copy: give every listed post written before migration 0071 its rows
 * in `post_hashtags`.
 *
 * WHY A SCRIPT AND NOT THE MIGRATION. 0071's triggers keep `post_hashtags`
 * current for every write from the moment they exist; what they cannot see is a
 * post nobody writes again. Copying those inside the migration would hold every
 * write to `posts` off for the whole copy (CREATE TRIGGER keeps SHARE ROW
 * EXCLUSIVE until commit): 425k public posts with 1.5M (post, tag) pairs, an
 * estimated 10-15 s on the production instance. Here each batch is a short
 * transaction over one id range.
 *
 * WHY IT IS EXACT WHILE WRITES CONTINUE. A batch reads its listed posts
 * `FOR SHARE` and inserts their rows in the same statement. A write that
 * committed before the lock is what the batch reads (under READ COMMITTED a
 * locked row is re-read at its newest version and re-checked against the
 * filter); a write that comes after waits for the batch to commit and then runs
 * the trigger, which rewrites that post's rows from its new state. So no batch
 * can copy a version of a post that a later write has already replaced. Rows the
 * triggers already wrote are left alone (`ON CONFLICT DO NOTHING`), which also
 * makes a re-run harmless.
 *
 * The listed filter and the copied columns are the trigger's, column for column:
 * public, published, not a collapsed crosspost variant, at least one tag; one row
 * per distinct non-null tag, with the post's `created_at`.
 *
 * SAFETY:
 *  1. `DRY_RUN` defaults to `true` and only counts; `DRY_RUN=false` writes.
 *  2. `assertAdminMutationAllowed` refuses a mutating run until the operator
 *     names the script back.
 *  3. Batched by primary key ({@link BATCH_SIZE} posts per range), pausing
 *     {@link PAUSE_MS} between batches so the request path keeps its I/O.
 *  4. Written counts are what Postgres reports inserting (`returning`).
 *
 * Runnable as a Fargate one-shot (DRY_RUN first):
 *   bun packages/backend/dist/src/scripts/backfillPostHashtags.js
 *   DRY_RUN=false CONFIRM_ADMIN_MUTATION=backfillPostHashtags \
 *     bun packages/backend/dist/src/scripts/backfillPostHashtags.js
 */

import { asc, gt, sql } from 'drizzle-orm';
import { connectPostgres, getDb } from '../db/postgres';
import { posts } from '../db/schema/posts';
import { logger } from '../utils/logger';
import { closeAdminScriptResources } from './lib/adminScriptLifecycle';
import { assertAdminMutationAllowed } from './lib/adminScriptSafety';

const SCRIPT_NAME = 'backfillPostHashtags';

/** Posts per id range. Most carry no tag, so a range copies a few hundred. */
const BATCH_SIZE = 1000;

/** Pause between ranges. */
const PAUSE_MS = 100;

/** Ranges between progress lines. */
const PROGRESS_EVERY_BATCHES = 50;

export interface PostHashtagsBackfillResult {
  /** Posts walked, listed or not. */
  postsScanned: number;
  /** Listed posts carrying at least one tag in the walked ranges. */
  postsListed: number;
  /** (post, tag) rows Postgres reported inserting. Always 0 on a dry run. */
  rowsWritten: number;
}

/** The trigger's filter, over the alias `p`, for the id range (`after`, `upTo`]. */
function listedInRange(after: string, upTo: string) {
  return sql`p.id > ${after} and p.id <= ${upTo}
    and p.visibility = 'public'
    and p.status = 'published'
    and p.crosspost_collapsed is not true
    and cardinality(p.hashtags) > 0`;
}

/**
 * The copy itself. The CALLER owns the connection lifecycle, so a test can run
 * it in-process against real rows.
 */
export async function backfillPostHashtags(
  opts: { dryRun?: boolean; pauseMs?: number } = {},
): Promise<PostHashtagsBackfillResult> {
  const dryRun = opts.dryRun ?? true;
  const pauseMs = opts.pauseMs ?? PAUSE_MS;
  const startedAt = Date.now();
  const result: PostHashtagsBackfillResult = { postsScanned: 0, postsListed: 0, rowsWritten: 0 };
  let cursor = '';
  let batches = 0;

  for (;;) {
    const range = await getDb()
      .select({ id: posts.id })
      .from(posts)
      .where(gt(posts.id, cursor))
      .orderBy(asc(posts.id))
      .limit(BATCH_SIZE);
    if (range.length === 0) break;
    const upTo = range[range.length - 1].id;
    result.postsScanned += range.length;

    if (dryRun) {
      const [counted] = await getDb().execute<{ listed: number }>(
        sql`select count(*)::int as listed from posts p where ${listedInRange(cursor, upTo)}`,
      );
      result.postsListed += counted?.listed ?? 0;
    } else {
      const [copied] = await getDb().execute<{ listed: number; written: number }>(sql`
        with listed as (
          select p.id, p.hashtags, p.created_at from posts p
          where ${listedInRange(cursor, upTo)}
          for share
        ), copied as (
          insert into post_hashtags (post_id, tag, created_at)
          select distinct listed.id, tag, listed.created_at
          from listed, unnest(listed.hashtags) as tag
          where tag is not null
          on conflict do nothing
          returning 1
        )
        select (select count(*) from listed)::int as listed, (select count(*) from copied)::int as written
      `);
      result.postsListed += copied?.listed ?? 0;
      result.rowsWritten += copied?.written ?? 0;
    }

    cursor = upTo;
    batches += 1;
    if (batches % PROGRESS_EVERY_BATCHES === 0) {
      logger.info(`[${SCRIPT_NAME}] progress`, { dryRun, ...result });
    }
    if (pauseMs > 0) await new Promise((resolve) => setTimeout(resolve, pauseMs));
  }

  logger.info(`[${SCRIPT_NAME}] complete`, {
    dryRun,
    ...result,
    elapsedSec: Math.round((Date.now() - startedAt) / 1000),
  });
  return result;
}

async function main(): Promise<void> {
  const dryRun = (process.env.DRY_RUN ?? 'true') !== 'false';
  assertAdminMutationAllowed({ scriptName: SCRIPT_NAME, dryRun });
  await connectPostgres();
  logger.info(`[${SCRIPT_NAME}] starting`, { dryRun });
  await backfillPostHashtags({ dryRun });
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
