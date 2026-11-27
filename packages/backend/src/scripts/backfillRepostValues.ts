/**
 * One-shot corpus backfill for the stored value rename `'boost'` -> `'repost'`
 * (docs/repost-rename.md, release 2 of 3): rewrite the rows written before the writers
 * flipped.
 *
 * Targets: `posts.type`, `notifications.type`, `feed_interactions.event`,
 * `federation_post_imports.initial_reason` and `federation_post_import_reasons.reason`
 * (`'boost_dependency'` -> `'repost_dependency'`). The CHECKs already accept both values (release 1),
 * every reader accepts both, and every writer now writes the new one, so this only brings the old rows
 * level. It touches only rows that still carry the old value, a page of ids at a time ordered by
 * primary key, so a re-run over a finished corpus writes nothing and an interruption loses nothing.
 *
 * The big tables are IO-bound (about 20 s per batch of 2000 on a cold `posts`), so a run can take the
 * corpus in slices: `--shard=k/N` takes the rows whose id hashes to `k` of `N`, and `N` runs can go at
 * once. The small tables are not sharded; shard 0 (or an unsharded run) does them.
 *
 * The CLI run goes through the backfill throttle (`lib/backfillThrottle.ts`): batches run only
 * inside the off-peak UTC window (`BACKFILL_WINDOW_UTC`, default 01-07) and back off when they slow
 * down. A run the throttle stops exits 75 and records its cursor in `admin_script_cursors`
 * (`throttle-stop:<table>`, or `throttle-stop:<table>/<k>of<N>` for a shard); `--table=<name> --after=<id>` resumes that one table there.
 *
 *   bun packages/backend/dist/src/scripts/backfillRepostValues.js --dry-run
 *   CONFIRM_ADMIN_MUTATION=backfillRepostValues bun packages/backend/dist/src/scripts/backfillRepostValues.js --shard=0/4
 */

import { type SQL, sql } from 'drizzle-orm';
import { connectPostgres, getDb } from '../db/postgres';
import { logger } from '../utils/logger';
import { closeAdminScriptResources } from './lib/adminScriptLifecycle';
import { assertAdminMutationAllowed } from './lib/adminScriptSafety';
import {
  type BackfillThrottle,
  backfillExitCode,
  createBackfillThrottle,
  fixedPauseThrottle,
} from './lib/backfillThrottle';

const DEFAULT_BATCH_SIZE = 2000;
/** Rest between batches, so the load stays a trickle autovacuum and the replicas keep up with. */
const DEFAULT_PAUSE_MS = 250;

interface Target {
  table: string;
  column: string;
  /** The key the pages walk; the row's identity for the rewrite. */
  idColumn: string;
  from: string;
  to: string;
  /** Only the big table is split between runs. */
  shardable: boolean;
  /** Reasons are keyed by (post_id, reason): a post that already has the new one must lose the old one. */
  dropWhenNewExists?: boolean;
}

export const REPOST_VALUE_TARGETS: readonly Target[] = [
  { table: 'posts', column: 'type', idColumn: 'id', from: 'boost', to: 'repost', shardable: true },
  {
    table: 'notifications',
    column: 'type',
    idColumn: 'id',
    from: 'boost',
    to: 'repost',
    shardable: false,
  },
  {
    table: 'feed_interactions',
    column: 'event',
    idColumn: 'id',
    from: 'boost',
    to: 'repost',
    shardable: false,
  },
  {
    table: 'federation_post_imports',
    column: 'initial_reason',
    idColumn: 'post_id',
    from: 'boost_dependency',
    to: 'repost_dependency',
    shardable: true,
  },
  {
    table: 'federation_post_import_reasons',
    column: 'reason',
    idColumn: 'post_id',
    from: 'boost_dependency',
    to: 'repost_dependency',
    shardable: true,
    dropWhenNewExists: true,
  },
];

export interface BackfillRepostValuesOptions {
  batchSize?: number;
  dryRun?: boolean;
  pauseMs?: number;
  shard?: { index: number; count: number };
  /** Narrow to some tables (the suites pass the one they seed). */
  only?: readonly string[];
  /** Narrow to some ids of each table's `idColumn` (the suites pass their fixtures). */
  ids?: readonly string[];
  /** Resume strictly after this key; only with exactly one table in `only`. */
  after?: string;
  /** Paces the batches. Default: a fixed `pauseMs` rest; the CLI passes the off-peak/backpressure guard. */
  throttle?: BackfillThrottle;
}

export type BackfillRepostValuesResult = Record<string, number>;

/** A deadlock aborts only the batch that lost it: redo that batch a few times before giving up. */
async function withDeadlockRetry<T>(run: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      const text = String(
        (error as { message?: unknown; cause?: { code?: unknown } })?.message ?? '',
      );
      const code =
        (error as { cause?: { code?: unknown }; code?: unknown })?.cause?.code ??
        (error as { code?: unknown })?.code;
      const isDeadlock = code === '40P01' || text.includes('deadlock detected');
      if (!isDeadlock || attempt >= 5) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
    }
  }
}

const idList = (ids: readonly string[]): SQL =>
  sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  );

/** Rewrite the old value of every target, returning how many rows each table had left to do. */
export async function backfillRepostValues(
  opts: BackfillRepostValuesOptions = {},
): Promise<BackfillRepostValuesResult> {
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
  const pauseMs = opts.pauseMs ?? DEFAULT_PAUSE_MS;
  const shard = opts.shard;
  if (
    shard &&
    !(
      Number.isInteger(shard.count) &&
      shard.count > 0 &&
      shard.index >= 0 &&
      shard.index < shard.count
    )
  ) {
    throw new Error(`Invalid shard ${shard.index}/${shard.count}`);
  }
  if (opts.after !== undefined && opts.only?.length !== 1) {
    throw new Error('A resume cursor (after) needs exactly one table (only)');
  }
  const throttle = opts.throttle ?? fixedPauseThrottle(pauseMs);
  const db = getDb();
  const result: BackfillRepostValuesResult = {};

  for (const target of REPOST_VALUE_TARGETS) {
    if (opts.only && !opts.only.includes(target.table)) continue;
    // The small tables are done once, by the first slice.
    if (!target.shardable && shard && shard.index !== 0) continue;

    const table = sql.raw(`"${target.table}"`);
    const column = sql.raw(`"${target.column}"`);
    const idColumn = sql.raw(`"${target.idColumn}"`);
    const scope = opts.ids ? sql`and ${idColumn} in (${idList(opts.ids)})` : sql``;
    const shardScope =
      shard && target.shardable
        ? sql`and mod(hashtext(${idColumn})::bigint & 2147483647, ${shard.count}) = ${shard.index}`
        : sql``;

    let cursor = opts.after ?? '';
    let done = 0;
    const scopeName =
      shard && target.shardable ? `${target.table}/${shard.index}of${shard.count}` : target.table;
    for (;;) {
      await throttle.beforeBatch({ cursor: cursor || null, scope: scopeName, scanned: done });
      const page = await db.execute<{ id: string }>(sql`
        select ${idColumn} as id from ${table}
        where ${idColumn} > ${cursor} and ${column} = ${target.from} ${scope} ${shardScope}
        order by ${idColumn}
        limit ${batchSize}
      `);
      if (page.length === 0) break;
      const ids = page.map((row) => row.id);
      cursor = ids[ids.length - 1];
      done += ids.length;
      if (opts.dryRun) continue;

      if (target.dropWhenNewExists) {
        await withDeadlockRetry(() =>
          db.execute(sql`
          delete from ${table} old
          where old.${idColumn} in (${idList(ids)}) and old.${column} = ${target.from}
            and exists (
              select 1 from ${table} new
              where new.${idColumn} = old.${idColumn} and new.${column} = ${target.to}
            )
        `),
        );
      }
      // Lock the rows in key order first: two writers that take the same rows in different orders
      // deadlock, and the app writes these rows (counters, edits) while the backfill runs.
      await withDeadlockRetry(() =>
        db.execute(sql`
          update ${table} set ${column} = ${target.to}
          where ${idColumn} in (
            select ${idColumn} from ${table}
            where ${idColumn} in (${idList(ids)}) and ${column} = ${target.from}
            order by ${idColumn} for update
          )
        `),
      );
    }
    result[target.table] = done;
    logger.info('[backfillRepostValues] table done', {
      table: target.table,
      column: target.column,
      rows: done,
    });
  }
  return result;
}

/** `--shard=k/N`: this run takes the k-th of N slices of the big tables. */
function shardFromArgs(): { index: number; count: number } | undefined {
  const arg = process.argv.find((value) => value.startsWith('--shard='));
  if (!arg) return undefined;
  const [index, count] = arg.slice('--shard='.length).split('/').map(Number);
  return { index, count };
}

/** `--name=value` from the command line. */
function argValue(name: string): string | undefined {
  const arg = process.argv.find((value) => value.startsWith(`--${name}=`));
  return arg?.slice(name.length + 3);
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  try {
    assertAdminMutationAllowed({ scriptName: 'backfillRepostValues', dryRun });
    // Built before connecting, so a malformed BACKFILL_* value fails before any work.
    const throttle = createBackfillThrottle({
      script: 'backfillRepostValues',
      pauseMs: DEFAULT_PAUSE_MS,
    });
    const table = argValue('table');
    if (table && !REPOST_VALUE_TARGETS.some((target) => target.table === table)) {
      throw new Error(`Unknown table ${table}`);
    }
    await connectPostgres();
    const result = await backfillRepostValues({
      dryRun,
      shard: shardFromArgs(),
      throttle,
      ...(table ? { only: [table] } : {}),
      after: argValue('after'),
    });
    logger.info('[backfillRepostValues] done', { dryRun, result });
  } catch (error) {
    logger.error('[backfillRepostValues] failed', error);
    throw error;
  } finally {
    await closeAdminScriptResources();
  }
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((error) => process.exit(backfillExitCode(error)));
}
