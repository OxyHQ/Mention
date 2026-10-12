/**
 * One-shot, POST-DEPLOY step for `drizzle/0054_instagram_graph_source.sql`.
 *
 *  1. Give every post the kilogram.makeup bridge delivered BEFORE 0054 its
 *     Instagram source key (`post_source_keys`), so the Graph import and the
 *     bridge dedupe against those posts through the same UNIQUE key as against
 *     new ones (the importer also recognises them by Note id, so this is what
 *     makes the guarantee a database one for old rows too).
 *  2. `VALIDATE CONSTRAINT` the three CHECKs 0054 added `NOT VALID` (so the
 *     migration scanned no row under ACCESS EXCLUSIVE). VALIDATE takes only
 *     SHARE UPDATE EXCLUSIVE: reads and writes of the tables continue.
 *
 * HOW IT WALKS. Bridge actors (`federated_actors.domain = 'kilogram.makeup'`) by
 * primary key, {@link ACTOR_BATCH} at a time; for each, its posts through
 * `posts_federation_actor_uri_idx` (one indexed range per actor — never a scan
 * of `posts`), inserting the keys of those that have none in one short
 * statement per actor with `ON CONFLICT DO NOTHING`. It pauses
 * {@link PAUSE_MS} between actor batches so the request path keeps its I/O.
 *
 * SAFETY:
 *  1. `DRY_RUN` defaults to `true`: it counts what it would write and writes
 *     nothing (and validates nothing).
 *  2. `assertAdminMutationAllowed` refuses a mutating run until the operator
 *     names the script back.
 *  3. Idempotent: a post that has its key is skipped, a key another post holds
 *     is counted under `conflicts`, a key a live Graph import is claiming is
 *     counted under `claimed` (re-run later), and VALIDATE of a validated
 *     constraint is a no-op. VALIDATE waits at most 5 s for its lock and is
 *     reported under `unvalidated` if it could not. A run killed part-way
 *     resumes by running it again.
 *
 * Runnable as a Fargate one-shot (DRY_RUN first):
 *   bun packages/backend/dist/src/scripts/backfillInstagramSourceKeys.js
 *   DRY_RUN=false CONFIRM_ADMIN_MUTATION=backfillInstagramSourceKeys \
 *     bun packages/backend/dist/src/scripts/backfillInstagramSourceKeys.js
 */

import { and, asc, eq, gt, isNull, lt, sql } from 'drizzle-orm';
import { connectPostgres, getDb } from '../db/postgres';
import { federatedActors } from '../db/schema/federation';
import { postSourceKeys } from '../db/schema/postContent';
import { posts } from '../db/schema/posts';
import {
  instagramSourceKeyFromApObjectUri,
  INSTAGRAM_AP_BRIDGE_HOSTS,
} from '../connectors/shared/instagramSourceKey';
import { logger } from '../utils/logger';
import { closeAdminScriptResources } from './lib/adminScriptLifecycle';
import { assertAdminMutationAllowed } from './lib/adminScriptSafety';

const SCRIPT_NAME = 'backfillInstagramSourceKeys';

/** Bridge actors per batch. */
const ACTOR_BATCH = 200;
/** Pause between actor batches. */
const PAUSE_MS = 50;

/** The CHECKs 0054 added NOT VALID. */
export const NOT_VALID_CONSTRAINTS: ReadonlyArray<{ table: string; constraint: string }> = [
  { table: 'federated_actors', constraint: 'federated_actors_protocol_check' },
  { table: 'federated_actors', constraint: 'federated_actors_instagram_graph_last_result_check' },
  { table: 'federated_follows', constraint: 'federated_follows_network_check' },
];

export interface InstagramSourceKeyBackfillResult {
  actors: number;
  /** Bridge posts with no source key yet that carry a derivable one. */
  candidates: number;
  /** Keys written. Always 0 on a dry run. */
  written: number;
  /** Keys already held by another post (left alone — that post IS the source). */
  conflicts: number;
  /**
   * Keys a live Graph import currently CLAIMS (it is re-hosting that post's
   * media right now). Left alone; re-run the script after the claim settles —
   * if the import fills it this post becomes a conflict, if it gives up the key
   * is free.
   */
  claimed: number;
  /** Constraints validated by this run. */
  validated: string[];
  /** Constraints whose VALIDATE could not get its lock in time — re-run. */
  unvalidated: string[];
}

/** VALIDATE waits at most this long for its lock rather than queueing writers behind it. */
const VALIDATE_LOCK_TIMEOUT = '5s';

type KeyOutcome = 'written' | 'conflict' | 'claimed';

/**
 * Give `postId` the key `sourceKey`: take over a claim whose holder died, or
 * insert a fresh row. A key that is filled, or claimed by a live holder, is
 * reported rather than silently skipped.
 */
async function attachKey(postId: string, sourceKey: string): Promise<KeyOutcome> {
  const tookOver = await getDb()
    .update(postSourceKeys)
    .set({ postId, claimedUntil: null, claimToken: null })
    .where(
      and(
        eq(postSourceKeys.sourceKey, sourceKey),
        isNull(postSourceKeys.postId),
        lt(postSourceKeys.claimedUntil, sql`now()`),
      ),
    )
    .returning({ id: postSourceKeys.id });
  if (tookOver.length > 0) return 'written';
  const inserted = await getDb()
    .insert(postSourceKeys)
    .values({ postId, sourceKey })
    .onConflictDoNothing()
    .returning({ id: postSourceKeys.id });
  if (inserted.length > 0) return 'written';
  const [existing] = await getDb()
    .select({ postId: postSourceKeys.postId })
    .from(postSourceKeys)
    .where(eq(postSourceKeys.sourceKey, sourceKey));
  return existing?.postId ? 'conflict' : 'claimed';
}

/** The bridge posts of one actor that have no source key, with the key they should get. */
async function keylessPostsOf(
  actorUri: string,
): Promise<Array<{ postId: string; sourceKey: string }>> {
  const rows = await getDb()
    .select({ id: posts.id, activityId: posts.federationActivityId })
    .from(posts)
    .leftJoin(postSourceKeys, eq(postSourceKeys.postId, posts.id))
    .where(and(eq(posts.federationActorUri, actorUri), isNull(postSourceKeys.id)));
  return rows.flatMap((row) => {
    const sourceKey = instagramSourceKeyFromApObjectUri(row.activityId);
    return sourceKey ? [{ postId: row.id, sourceKey }] : [];
  });
}

async function validateConstraints(): Promise<{ validated: string[]; unvalidated: string[] }> {
  const validated: string[] = [];
  const unvalidated: string[] = [];
  for (const { table, constraint } of NOT_VALID_CONSTRAINTS) {
    const [row] = await getDb().execute<{ convalidated: boolean }>(sql`
      select convalidated from pg_constraint where conname = ${constraint}
    `);
    if (!row || row.convalidated) continue;
    try {
      // SHARE UPDATE EXCLUSIVE does not block reads or writes, but waiting for
      // it behind a long transaction would queue every LATER ALTER / lock
      // request on the table; bounded, and reported, instead.
      await getDb().transaction(async (tx) => {
        await tx.execute(sql.raw(`set local lock_timeout = '${VALIDATE_LOCK_TIMEOUT}'`));
        await tx.execute(sql.raw(`alter table "${table}" validate constraint "${constraint}"`));
      });
      validated.push(constraint);
    } catch (err) {
      logger.warn(`[${SCRIPT_NAME}] could not validate a constraint in time; re-run`, {
        constraint,
        reason: err instanceof Error ? err.message : 'unknown',
      });
      unvalidated.push(constraint);
    }
  }
  return { validated, unvalidated };
}

/** The backfill. The CALLER owns the connection lifecycle, so a test can run it in-process. */
export async function backfillInstagramSourceKeys(
  opts: { dryRun?: boolean; pauseMs?: number; bridgeHosts?: ReadonlySet<string> } = {},
): Promise<InstagramSourceKeyBackfillResult> {
  const dryRun = opts.dryRun ?? true;
  const pauseMs = opts.pauseMs ?? PAUSE_MS;
  const hosts = [...(opts.bridgeHosts ?? INSTAGRAM_AP_BRIDGE_HOSTS)];
  const result: InstagramSourceKeyBackfillResult = {
    actors: 0,
    candidates: 0,
    written: 0,
    conflicts: 0,
    claimed: 0,
    validated: [],
    unvalidated: [],
  };

  for (const host of hosts) {
    let after = '';
    for (;;) {
      const actors = await getDb()
        .select({ id: federatedActors.id, uri: federatedActors.uri })
        .from(federatedActors)
        .where(and(eq(federatedActors.domain, host), gt(federatedActors.id, after)))
        .orderBy(asc(federatedActors.id))
        .limit(ACTOR_BATCH);
      if (actors.length === 0) break;
      after = actors[actors.length - 1].id;

      for (const actor of actors) {
        result.actors += 1;
        const keyless = await keylessPostsOf(actor.uri);
        result.candidates += keyless.length;
        if (dryRun) continue;
        for (const { postId, sourceKey } of keyless) {
          const outcome = await attachKey(postId, sourceKey);
          if (outcome === 'written') result.written += 1;
          else if (outcome === 'conflict') result.conflicts += 1;
          else result.claimed += 1;
        }
      }
      if (pauseMs > 0) await new Promise((resolve) => setTimeout(resolve, pauseMs));
    }
  }

  if (!dryRun) Object.assign(result, await validateConstraints());
  logger.info(`[${SCRIPT_NAME}] complete`, { dryRun, ...result });
  return result;
}

/** The exit code of a run that finished with work left over (re-run later) — not a failure. */
export const EXIT_INCOMPLETE = 75;

/**
 * 0 when every key was written or settled and every CHECK validated;
 * {@link EXIT_INCOMPLETE} when a key was held by a live Graph claim or a
 * VALIDATE could not get its lock in time — both are "re-run later", and the
 * one-shot workflow reports them that way rather than as a failure.
 */
export function sourceKeyBackfillExitCode(
  result: Pick<InstagramSourceKeyBackfillResult, 'claimed' | 'unvalidated'>,
): number {
  return result.claimed > 0 || result.unvalidated.length > 0 ? EXIT_INCOMPLETE : 0;
}

async function main(): Promise<void> {
  const dryRun = (process.env.DRY_RUN ?? 'true') !== 'false';
  assertAdminMutationAllowed({ scriptName: SCRIPT_NAME, dryRun });
  await connectPostgres();
  logger.info(`[${SCRIPT_NAME}] starting`, { dryRun });
  const result = await backfillInstagramSourceKeys({ dryRun });
  process.exitCode = sourceKeyBackfillExitCode(result);
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
      process.exit(1);
    });
}
