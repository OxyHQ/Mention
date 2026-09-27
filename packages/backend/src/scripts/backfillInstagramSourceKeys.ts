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
 *     is counted under `conflicts` and left alone, and VALIDATE of a validated
 *     constraint is a no-op. A run killed part-way resumes by running it again.
 *
 * Runnable as a Fargate one-shot (DRY_RUN first):
 *   bun packages/backend/dist/src/scripts/backfillInstagramSourceKeys.js
 *   DRY_RUN=false CONFIRM_ADMIN_MUTATION=backfillInstagramSourceKeys \
 *     bun packages/backend/dist/src/scripts/backfillInstagramSourceKeys.js
 */

import { and, asc, eq, gt, isNull, sql } from 'drizzle-orm';
import { connectPostgres, getDb } from '../db/postgres';
import { federatedActors } from '../db/schema/federation';
import { postSourceKeys } from '../db/schema/postContent';
import { posts } from '../db/schema/posts';
import { instagramSourceKeyFromApObjectUri, INSTAGRAM_AP_BRIDGE_HOSTS } from '../connectors/shared/instagramSourceKey';
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
  /** Keys already held by another post (left alone). */
  conflicts: number;
  /** Constraints validated by this run. */
  validated: string[];
}

/** The bridge posts of one actor that have no source key, with the key they should get. */
async function keylessPostsOf(actorUri: string): Promise<Array<{ postId: string; sourceKey: string }>> {
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

async function validateConstraints(): Promise<string[]> {
  const validated: string[] = [];
  for (const { table, constraint } of NOT_VALID_CONSTRAINTS) {
    const [row] = await getDb().execute<{ convalidated: boolean }>(sql`
      select convalidated from pg_constraint where conname = ${constraint}
    `);
    if (!row || row.convalidated) continue;
    await getDb().execute(sql.raw(`alter table "${table}" validate constraint "${constraint}"`));
    validated.push(constraint);
  }
  return validated;
}

/** The backfill. The CALLER owns the connection lifecycle, so a test can run it in-process. */
export async function backfillInstagramSourceKeys(
  opts: { dryRun?: boolean; pauseMs?: number; bridgeHosts?: ReadonlySet<string> } = {},
): Promise<InstagramSourceKeyBackfillResult> {
  const dryRun = opts.dryRun ?? true;
  const pauseMs = opts.pauseMs ?? PAUSE_MS;
  const hosts = [...(opts.bridgeHosts ?? INSTAGRAM_AP_BRIDGE_HOSTS)];
  const result: InstagramSourceKeyBackfillResult = { actors: 0, candidates: 0, written: 0, conflicts: 0, validated: [] };

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
        if (dryRun || keyless.length === 0) continue;
        const inserted = await getDb()
          .insert(postSourceKeys)
          .values(keyless.map(({ postId, sourceKey }) => ({ postId, sourceKey })))
          .onConflictDoNothing()
          .returning({ id: postSourceKeys.id });
        result.written += inserted.length;
        result.conflicts += keyless.length - inserted.length;
      }
      if (pauseMs > 0) await new Promise((resolve) => setTimeout(resolve, pauseMs));
    }
  }

  if (!dryRun) result.validated = await validateConstraints();
  logger.info(`[${SCRIPT_NAME}] complete`, { dryRun, ...result });
  return result;
}

async function main(): Promise<void> {
  const dryRun = (process.env.DRY_RUN ?? 'true') !== 'false';
  assertAdminMutationAllowed({ scriptName: SCRIPT_NAME, dryRun });
  await connectPostgres();
  logger.info(`[${SCRIPT_NAME}] starting`, { dryRun });
  await backfillInstagramSourceKeys({ dryRun });
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
