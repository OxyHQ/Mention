/**
 * One-shot: give every post a keyed transport delivered BEFORE its key was
 * written its upstream post key (`post_source_keys`; `connectors/shared/upstreamPostKey.ts`):
 * bird.makeup posts (`x:<tweet id>`), native atproto and Bridgy Fed posts
 * (`bluesky:<at-uri>`), and kilogram.makeup posts (`instagram:<shortcode>`). A
 * later copy of the same post from another transport then meets the stored one
 * through the same UNIQUE key as it meets a new one.
 *
 * HOW IT WALKS. The actors of the keyed transports (`federated_actors` on a
 * keyed mirror host or Bridgy Fed, and every atproto actor) by primary key,
 * {@link ACTOR_BATCH} at a time; for each, its posts through
 * `posts_federation_actor_author_idx` (one indexed range per actor — never a scan
 * of `posts`), keying those that have none. It pauses {@link PAUSE_MS} between
 * actor batches so the request path keeps its I/O.
 *
 * SAFETY:
 *  1. `DRY_RUN` defaults to `true`: it counts what it would write and writes nothing.
 *  2. `assertAdminMutationAllowed` refuses a mutating run until the operator
 *     names the script back.
 *  3. Idempotent: a post that has its key is skipped, a key another post holds
 *     is counted under `conflicts` (that post IS the upstream post; the two are
 *     left for the merge, which runs when a copy is next delivered), a key a live
 *     Graph import is claiming is counted under `claimed` (re-run later). A run
 *     killed part-way resumes by running it again.
 *
 * Runnable as a Fargate one-shot (DRY_RUN first):
 *   bun packages/backend/dist/src/scripts/backfillUpstreamPostKeys.js
 *   DRY_RUN=false CONFIRM_ADMIN_MUTATION=backfillUpstreamPostKeys \
 *     bun packages/backend/dist/src/scripts/backfillUpstreamPostKeys.js
 */

import { and, asc, eq, gt, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { connectPostgres, getDb } from '../db/postgres';
import { federatedActors } from '../db/schema/federation';
import { postSourceKeys } from '../db/schema/postContent';
import { posts } from '../db/schema/posts';
import { upstreamPostKey } from '../connectors/shared/upstreamPostKey';
import { keyedMirrorHosts } from '../utils/federation/mirrorTransports';
import { logger } from '../utils/logger';
import { closeAdminScriptResources } from './lib/adminScriptLifecycle';
import { assertAdminMutationAllowed } from './lib/adminScriptSafety';
import { sleep } from '../utils/sleep';

const SCRIPT_NAME = 'backfillUpstreamPostKeys';

/** Transport actors per batch. */
const ACTOR_BATCH = 200;
/** Pause between actor batches. */
const PAUSE_MS = 50;

/** The hosts whose ActivityPub object ids name the upstream post. */
const KEYED_AP_HOSTS = [...keyedMirrorHosts('x'), ...keyedMirrorHosts('instagram'), 'bsky.brid.gy'];

export interface UpstreamPostKeyBackfillResult {
  actors: number;
  /** Posts with no key yet whose object id names one. */
  candidates: number;
  /** Keys written. Always 0 on a dry run. */
  written: number;
  /** Keys already held by another post (the same upstream post, stored twice). */
  conflicts: number;
  /** Keys a live Graph import currently claims; re-run after it settles. */
  claimed: number;
}

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

/** One actor's posts that have no key, with the key each should get. */
async function keylessPostsOf(
  actorUri: string,
): Promise<Array<{ postId: string; sourceKey: string }>> {
  const rows = await getDb()
    .select({ id: posts.id, activityId: posts.federationActivityId })
    .from(posts)
    .leftJoin(postSourceKeys, eq(postSourceKeys.postId, posts.id))
    .where(and(eq(posts.federationActorUri, actorUri), isNull(postSourceKeys.id)));
  return rows.flatMap((row) => {
    const sourceKey = upstreamPostKey(row.activityId);
    return sourceKey ? [{ postId: row.id, sourceKey }] : [];
  });
}

/** The backfill. The CALLER owns the connection lifecycle, so a test can run it in-process. */
export async function backfillUpstreamPostKeys(
  opts: { dryRun?: boolean; pauseMs?: number } = {},
): Promise<UpstreamPostKeyBackfillResult> {
  const dryRun = opts.dryRun ?? true;
  const pauseMs = opts.pauseMs ?? PAUSE_MS;
  const result: UpstreamPostKeyBackfillResult = {
    actors: 0,
    candidates: 0,
    written: 0,
    conflicts: 0,
    claimed: 0,
  };

  let after = '';
  for (;;) {
    const actors = await getDb()
      .select({ id: federatedActors.id, uri: federatedActors.uri })
      .from(federatedActors)
      .where(
        and(
          or(
            inArray(federatedActors.domain, KEYED_AP_HOSTS),
            eq(federatedActors.protocol, 'atproto'),
          ),
          gt(federatedActors.id, after),
        ),
      )
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
    if (pauseMs > 0) await sleep(pauseMs);
  }

  logger.info(`[${SCRIPT_NAME}] complete`, { dryRun, ...result });
  return result;
}

/** The exit code of a run that finished with work left over (re-run later) — not a failure. */
export const EXIT_INCOMPLETE = 75;

/** 0 when every key was written or settled; {@link EXIT_INCOMPLETE} when a live claim held one. */
export function upstreamKeyBackfillExitCode(
  result: Pick<UpstreamPostKeyBackfillResult, 'claimed'>,
): number {
  return result.claimed > 0 ? EXIT_INCOMPLETE : 0;
}

async function main(): Promise<void> {
  const dryRun = (process.env.DRY_RUN ?? 'true') !== 'false';
  assertAdminMutationAllowed({ scriptName: SCRIPT_NAME, dryRun });
  await connectPostgres();
  logger.info(`[${SCRIPT_NAME}] starting`, { dryRun });
  const result = await backfillUpstreamPostKeys({ dryRun });
  process.exitCode = upstreamKeyBackfillExitCode(result);
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
