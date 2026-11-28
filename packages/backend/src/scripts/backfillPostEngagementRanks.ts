/**
 * One-shot copy and check of `post_engagement_ranks` (migrations 0141-0142).
 *
 * The triggers keep the table current for every write from the moment they
 * exist; what they cannot see is a post nobody writes again. This copies those,
 * then proves the table matches `posts` before the readers move to it
 * (`FEED_ENGAGEMENT_RANKS=on`).
 *
 * `MODE=copy` (the default) walks `posts` by primary key in id ranges of
 * {@link BATCH_SIZE} and inserts the range's listed posts (public, published,
 * rank not 0: the triggers' rule) with `ON CONFLICT DO NOTHING`. It takes NO row
 * locks, which is what keeps it cheap on a 13.7M-row table: locking the 4.1M
 * listed rows `FOR SHARE` (as `backfillPostHashtags` did for its 425k) would
 * write every one of them, dirtying nearly every heap page and its full-page
 * image in the WAL.
 *
 * WHY THE UNLOCKED COPY IS STILL SAFE. A post changed while its range is copied
 * is written by its trigger from its new state, and the copy never overwrites a
 * row (`DO NOTHING`), whichever of the two runs first: if the copy inserted
 * first, the trigger's update replaces the copied values; if the trigger did,
 * the copy skips the post. The one race left is a post LEAVING the set (deleted,
 * made private, its rank back to 0) after the copy read it and before the copy
 * inserted it: the trigger found no row to delete, and the copy then adds one.
 * The readers are still on the expression index then, and `MODE=verify` finds
 * and removes every such row before they move.
 *
 * `MODE=verify` walks the same ranges and compares the table with `posts`:
 * listed posts with no row, rows whose post is gone or unlisted, and rows whose
 * rank, `created_at`, `is_reply` or languages differ. With `DRY_RUN=false` it repairs each one under a
 * `FOR SHARE` lock on that post's row (only the few mismatched rows), so no
 * writer can change the post between the check and the fix. A verify run that
 * reports zero mismatches is the gate for turning the readers on.
 *
 * SAFETY:
 *  1. `DRY_RUN` defaults to `true` and only counts; `DRY_RUN=false` writes.
 *  2. `assertAdminMutationAllowed` refuses a mutating run until the operator
 *     names the script back.
 *  3. Off-peak and latency-throttled through `createBackfillThrottle`; each
 *     batch is one short statement over one id range.
 *  4. Resumable: re-running is harmless (the copy skips existing rows), and
 *     `START_AFTER_ID=<id>` starts after the id a stopped run last logged.
 *
 * Runnable as a Fargate one-shot (DRY_RUN first):
 *   bun packages/backend/dist/src/scripts/backfillPostEngagementRanks.js
 *   DRY_RUN=false CONFIRM_ADMIN_MUTATION=backfillPostEngagementRanks \
 *     bun packages/backend/dist/src/scripts/backfillPostEngagementRanks.js
 *   MODE=verify bun packages/backend/dist/src/scripts/backfillPostEngagementRanks.js
 */

import { asc, gt, sql, type SQL } from 'drizzle-orm';
import { connectPostgres, getDb } from '../db/postgres';
import { posts } from '../db/schema/posts';
import { logger } from '../utils/logger';
import { closeAdminScriptResources } from './lib/adminScriptLifecycle';
import { assertAdminMutationAllowed } from './lib/adminScriptSafety';
import {
  type BackfillThrottle,
  backfillExitCode,
  createBackfillThrottle,
  fixedPauseThrottle,
} from './lib/backfillThrottle';

const SCRIPT_NAME = 'backfillPostEngagementRanks';

/** Posts per id range. About 30% of them are listed, so a copy batch writes ~1,500 rows. */
const BATCH_SIZE = 5000;

/** Pause between ranges. */
const PAUSE_MS = 100;

/** Ranges between progress lines. */
const PROGRESS_EVERY_BATCHES = 50;

export type PostEngagementRanksMode = 'copy' | 'verify';

export interface PostEngagementRanksResult {
  mode: PostEngagementRanksMode;
  /** Posts walked, listed or not. */
  postsScanned: number;
  /** Listed posts in the walked ranges. */
  postsListed: number;
  /** `copy`: rows Postgres reported inserting. Always 0 on a dry run. */
  rowsWritten: number;
  /** `verify`: listed posts with no row. */
  missing: number;
  /** `verify`: rows whose post is gone or no longer listed. */
  extra: number;
  /** `verify`: rows whose rank, `created_at`, `is_reply` or languages are not the post's. */
  mismatched: number;
  /** `verify`: mismatches repaired. Always 0 on a dry run. */
  repaired: number;
  /** The last id walked, for `START_AFTER_ID`. */
  lastId: string | null;
}

/** The triggers' rule, over the alias `p`. */
const LISTED = sql`p.visibility = 'public' and p.status = 'published'
  and post_engagement_rank(p.stats_likes_count, p.stats_reposts_count,
    p.stats_federated_reposts_count, p.stats_comments_count) <> 0`;

const RANK = sql`post_engagement_rank(p.stats_likes_count, p.stats_reposts_count,
  p.stats_federated_reposts_count, p.stats_comments_count)`;

/** The trigger's `languages`: the two arrays concatenated, NULL as empty. */
const LANGUAGES = sql`coalesce(p.classification_languages, '{}') || coalesce(p.translated_languages, '{}')`;

/** Range bounds `(after, upTo]`; `upTo` null means everything after `after`. */
function inRange(column: SQL, after: string, upTo: string | null): SQL {
  return upTo === null
    ? sql`${column} > ${after}`
    : sql`${column} > ${after} and ${column} <= ${upTo}`;
}

/** Ids in `(after, upTo]` where the table and `posts` disagree, by kind. */
async function findMismatches(
  after: string,
  upTo: string | null,
): Promise<{ id: string; kind: 'missing' | 'extra' | 'mismatched' }[]> {
  return getDb().execute<{ id: string; kind: 'missing' | 'extra' | 'mismatched' }>(sql`
    with expected as (
      select p.id, ${RANK} as engagement_rank, p.created_at, p.is_reply, ${LANGUAGES} as languages
      from posts p
      where ${inRange(sql.raw('p.id'), after, upTo)} and ${LISTED}
    ), actual as (
      select r.post_id, r.engagement_rank, r.created_at, r.is_reply, r.languages
      from post_engagement_ranks r
      where ${inRange(sql.raw('r.post_id'), after, upTo)}
    )
    select coalesce(e.id, a.post_id) as id,
      case when a.post_id is null then 'missing'
           when e.id is null then 'extra'
           else 'mismatched' end as kind
    from expected e
    full join actual a on a.post_id = e.id
    where a.post_id is null or e.id is null
      or (a.engagement_rank, a.created_at, a.is_reply, a.languages)
        is distinct from (e.engagement_rank, e.created_at, e.is_reply, e.languages)
  `);
}

/**
 * Make each post's row what its `posts` row says, under a `FOR SHARE` lock on
 * that row: an UPDATE of the post (and so its trigger) waits for this to commit,
 * and this reads the post's newest committed version.
 */
async function repair(ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;
  return getDb().transaction(async (tx) => {
    const locked = await tx.execute<{ id: string }>(sql`
      select p.id from posts p where p.id = any(${sql.param(ids)}::text[]) order by p.id for share
    `);
    await tx.execute(
      sql`delete from post_engagement_ranks where post_id = any(${sql.param(ids)}::text[])`,
    );
    const lockedIds = locked.map((row) => row.id);
    if (lockedIds.length > 0) {
      await tx.execute(sql`
        insert into post_engagement_ranks (post_id, engagement_rank, created_at, is_reply, languages)
        select p.id, ${RANK}, p.created_at, p.is_reply, ${LANGUAGES}
        from posts p
        where p.id = any(${sql.param(lockedIds)}::text[]) and ${LISTED}
      `);
    }
    return ids.length;
  });
}

/**
 * The copy or the check. The CALLER owns the connection lifecycle, so a test can
 * run it in-process against real rows.
 */
export async function backfillPostEngagementRanks(
  opts: {
    mode?: PostEngagementRanksMode;
    dryRun?: boolean;
    pauseMs?: number;
    throttle?: BackfillThrottle;
    startAfterId?: string;
    batchSize?: number;
  } = {},
): Promise<PostEngagementRanksResult> {
  const mode = opts.mode ?? 'copy';
  const dryRun = opts.dryRun ?? true;
  const batchSize = opts.batchSize ?? BATCH_SIZE;
  const throttle = opts.throttle ?? fixedPauseThrottle(opts.pauseMs ?? PAUSE_MS);
  const startedAt = Date.now();
  const result: PostEngagementRanksResult = {
    mode,
    postsScanned: 0,
    postsListed: 0,
    rowsWritten: 0,
    missing: 0,
    extra: 0,
    mismatched: 0,
    repaired: 0,
    lastId: null,
  };
  let cursor = opts.startAfterId ?? '';
  let batches = 0;

  for (;;) {
    await throttle.beforeBatch({ cursor: cursor || null, scanned: result.postsScanned });
    const range = await getDb()
      .select({ id: posts.id })
      .from(posts)
      .where(gt(posts.id, cursor))
      .orderBy(asc(posts.id))
      .limit(batchSize);
    // The last range is open-ended, so `verify` also sees rows past the last post.
    const upTo = range.length === batchSize ? range[range.length - 1].id : null;
    result.postsScanned += range.length;

    if (mode === 'copy') {
      if (range.length === 0) break;
      if (dryRun) {
        const [counted] = await getDb().execute<{ listed: number }>(
          sql`select count(*)::int as listed from posts p
              where ${inRange(sql.raw('p.id'), cursor, upTo)} and ${LISTED}`,
        );
        result.postsListed += counted?.listed ?? 0;
      } else {
        const [copied] = await getDb().execute<{ listed: number; written: number }>(sql`
          with listed as (
            select p.id, ${RANK} as engagement_rank, p.created_at, p.is_reply,
              ${LANGUAGES} as languages
            from posts p
            where ${inRange(sql.raw('p.id'), cursor, upTo)} and ${LISTED}
          ), copied as (
            insert into post_engagement_ranks (post_id, engagement_rank, created_at, is_reply, languages)
            select id, engagement_rank, created_at, is_reply, languages from listed
            on conflict (post_id) do nothing
            returning 1
          )
          select (select count(*) from listed)::int as listed,
                 (select count(*) from copied)::int as written
        `);
        result.postsListed += copied?.listed ?? 0;
        result.rowsWritten += copied?.written ?? 0;
      }
    } else {
      const found = await findMismatches(cursor, upTo);
      for (const row of found) result[row.kind] += 1;
      if (!dryRun) result.repaired += await repair(found.map((row) => row.id));
    }

    if (upTo === null) {
      result.lastId = range.length > 0 ? range[range.length - 1].id : cursor || null;
      break;
    }
    cursor = upTo;
    result.lastId = upTo;
    batches += 1;
    if (batches % PROGRESS_EVERY_BATCHES === 0) {
      logger.info(`[${SCRIPT_NAME}] progress`, { dryRun, ...result });
    }
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
  const mode: PostEngagementRanksMode = process.env.MODE === 'verify' ? 'verify' : 'copy';
  assertAdminMutationAllowed({ scriptName: SCRIPT_NAME, dryRun });
  const throttle = createBackfillThrottle({ script: SCRIPT_NAME, pauseMs: PAUSE_MS, dryRun });
  await connectPostgres();
  logger.info(`[${SCRIPT_NAME}] starting`, { dryRun, mode });
  const result = await backfillPostEngagementRanks({
    mode,
    dryRun,
    throttle,
    startAfterId: process.env.START_AFTER_ID || undefined,
  });
  if (mode === 'verify' && result.missing + result.extra + result.mismatched > result.repaired) {
    // Not a crash: the table is not yet ready for the readers.
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main()
    .then(async () => {
      await closeAdminScriptResources();
      process.exit(process.exitCode ?? 0);
    })
    .catch(async (error) => {
      logger.error(`[${SCRIPT_NAME}] failed`, {
        reason: error instanceof Error ? error.message : 'unknown',
      });
      await closeAdminScriptResources().catch(() => undefined);
      process.exit(backfillExitCode(error));
    });
}
