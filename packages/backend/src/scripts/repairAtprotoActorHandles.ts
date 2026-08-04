/**
 * One-shot REPAIR of stored atproto (Bluesky) actor handles whose rendered
 * `local@domain` no longer matches the current `splitHandle` derivation.
 *
 * WHY
 *   Two `splitHandle` (`connectors/atproto/profile.mapper.ts`) changes each left
 *   stale rows behind:
 *     1. It used to derive an actor's instance domain by stripping the first label
 *        off its handle — wrong for the atproto connector, where the instance domain
 *        is ALWAYS the Bluesky network host (`bsky.social`). A multi-label custom
 *        domain handle mis-derived its instance:
 *          - `mayor.nyc.gov`  → parent `nyc.gov`  → stored domain `nyc.gov`  (WRONG)
 *          - `jay.bsky.team`  → parent `bsky.team` → stored domain `bsky.team` (WRONG)
 *          - `ronbronson.com` → parent `com`      → stored domain `com`      (WRONG)
 *        so the actor rendered as `@mayor.nyc.gov@nyc.gov` instead of the correct
 *        `@mayor.nyc.gov@bsky.social`. (Apex handles like `gothamist.com` happened to
 *        be correct only because a bare TLD has no dot to strip.)
 *     2. It now also strips the redundant `.bsky.social` suffix from a DEFAULT handle
 *        (the instance domain is already `bsky.social`), so `skylee1.bsky.social`
 *        renders `@skylee1@bsky.social`, not the doubled `@skylee1.bsky.social@bsky.social`.
 *        These rows keep their `domain` (`bsky.social`) but the `username` shortens.
 *   The ingest path is now fixed, but rows written before each fix keep their stale
 *   `username`/`domain`/`acct` binding — this script re-derives and repairs them in
 *   place.
 *
 * WHAT IT DOES — per `FederatedActor` row with `protocol:'atproto'`:
 *   1. Cheaply detects whether the row needs repair WITHOUT any network I/O:
 *      `splitHandle(acct).federatedUsername !== ${stored.username}@${stored.domain}`.
 *      Comparing the domain ALONE would MISS a `.bsky.social` actor, whose domain is
 *      unchanged while its username shortens. An already-correct actor is a no-op
 *      (logged `unchanged`, no fetch).
 *   2. When it differs, repairs it by re-running the SAME sanctioned upsert the
 *      ingest path uses — `fetchAndUpsertAtprotoProfile(did)` — which recomputes the
 *      handle through the FIXED `splitHandle` AND updates BOTH sides consistently
 *      through one code path: the Mention `FederatedActor` (domain / acct) and the
 *      linked Oxy user (via the shared identity bridge's `/users/resolve`). The `did`
 *      is the actor's stored `uri` (`did:plc:...` / `did:web:...`). We deliberately do
 *      NOT hand-write the Oxy update, so the two stores never drift.
 *
 *   There are only ~18 atproto actors in prod, so this scans them in one pass (no
 *   cursor batching), sequentially — the repair is one AppView fetch + one oxy-api
 *   round-trip per actor, and running them one at a time keeps the load on both
 *   trivial. The AppView/Oxy clients own request deadlines, and one actor's
 *   failure never aborts the loop.
 *
 * FLAGS (plain argv):
 *   --dry-run    log what WOULD change (stored `domain` → re-derived `domain`) and
 *                write nothing — the upsert is never called, so neither the
 *                `FederatedActor` nor the linked Oxy user is touched.
 *   --limit N    cap the number of actors processed (a canary budget). Actors are
 *                scanned in a stable ascending `_id` order so a limited run is
 *                deterministic.
 *
 * Idempotent + re-runnable: a repaired actor re-derives to the SAME `local@domain`
 * on a second run (`splitHandle(acct).federatedUsername === ${stored.username}@${stored.domain}`),
 * so it is then a no-op.
 *
 * RUN AS A FARGATE ONE-SHOT (post-deploy, in-VPC):
 *   bun packages/backend/dist/src/scripts/repairAtprotoActorHandles.js --dry-run
 *   CONFIRM_ADMIN_MUTATION=repairAtprotoActorHandles \
 *     bun packages/backend/dist/src/scripts/repairAtprotoActorHandles.js
 *
 * RUN OVER THE SSM TUNNEL (prod Mongo forwarded to 127.0.0.1:47017):
 *   MONGODB_URI='mongodb://127.0.0.1:47017/?directConnection=true' \
 *   NODE_ENV=production \
 *   bun packages/backend/src/scripts/repairAtprotoActorHandles.ts --dry-run
 *   (NODE_ENV=production selects the `mention-production` DB; drop --dry-run to
 *   write. The pool is ~18 actors, so the tunnel is fine.)
 */

import mongoose from 'mongoose';
import { scanActors } from '../db/federation/actorRepository';
import { connectPostgres, closePostgres } from '../db/postgres';
import { connectToDatabase } from '../utils/database';
import { fetchAndUpsertAtprotoProfile, splitHandle } from '../connectors/atproto/profile.mapper';
import { logger } from '../utils/logger';
import { assertAdminMutationAllowed } from './lib/adminScriptSafety';
import { assertAdminRunComplete } from './lib/adminScriptLifecycle';

/** Per-actor repair outcome. */
type RepairOutcome = 'repaired' | 'unchanged' | 'failed';

interface Flags {
  dryRun: boolean;
  limit?: number;
}

/** The `federated_actors` fields the repair reads. */
interface ActorRow {
  uri: string;
  acct: string;
  username: string;
  domain: string;
}

interface Counters {
  scanned: number;
  repaired: number;
  unchanged: number;
  failed: number;
}

// --- argv parsing (plain, mirrors the other one-shot scripts) ----------------

/** Read the value of `--flag <value>` / `--flag=value` from argv. */
function readFlagValue(argv: string[], name: string): string | undefined {
  const prefix = `${name}=`;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === name) return argv[i + 1];
    if (arg.startsWith(prefix)) return arg.slice(prefix.length);
  }
  return undefined;
}

function parseFlags(argv: string[]): Flags {
  const dryRun = argv.includes('--dry-run');

  const rawLimit = readFlagValue(argv, '--limit');
  let limit: number | undefined;
  if (rawLimit !== undefined) {
    const parsed = Number.parseInt(rawLimit, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new Error(`--limit must be a positive integer (got "${rawLimit}")`);
    }
    limit = parsed;
  }

  return { dryRun, limit };
}

// --- per-actor repair --------------------------------------------------------

/**
 * Repair one actor when its stored `${username}@${domain}` no longer matches the
 * re-derived `splitHandle(acct).federatedUsername`. Detection is a pure, network-free
 * comparison of the full `local@domain` (not the domain alone — a `.bsky.social`
 * actor shortens only its username); the actual repair re-runs the shared profile
 * upsert so the `FederatedActor` and the linked Oxy user stay consistent through one
 * code path. Fails soft: any error is caught by the caller and counted `failed` —
 * the loop is never aborted.
 */
async function repairActor(actor: ActorRow, flags: Flags): Promise<RepairOutcome> {
  if (!actor.acct) {
    logger.warn('[repairAtprotoActorHandles] actor has no account handle; skipping');
    return 'failed';
  }

  const expected = splitHandle(actor.acct);
  if (expected.federatedUsername === `${actor.username}@${actor.domain}`) {
    return 'unchanged';
  }

  logger.info('[repairAtprotoActorHandles] actor handle repair prepared', {
    dryRun: flags.dryRun,
  });
  if (flags.dryRun) return 'repaired';

  // The AppView/Oxy clients own their cancellable request deadlines. Do not wrap
  // this mutating upsert in Promise.race: losing promises continue to execute.
  const refreshed = await fetchAndUpsertAtprotoProfile(actor.uri);
  if (!refreshed) {
    logger.warn('[repairAtprotoActorHandles] profile upsert returned no actor; left untouched');
    return 'failed';
  }
  return 'repaired';
}

// --- entrypoint --------------------------------------------------------------

async function repairAtprotoActorHandles(): Promise<void> {
  const startedAt = Date.now();
  const flags = parseFlags(process.argv.slice(2));

  const counters: Counters = { scanned: 0, repaired: 0, unchanged: 0, failed: 0 };

  try {
    assertAdminMutationAllowed({
      scriptName: 'repairAtprotoActorHandles',
      dryRun: flags.dryRun,
    });
    await connectToDatabase();
    // The actor rows are in Postgres; the shared profile upsert this repair calls
    // also reaches Oxy, and the Mongo connection stays open for the rest of the
    // process's imported singletons.
    await connectPostgres();
    logger.info(
      `[repairAtprotoActorHandles] connected — mode: ${flags.dryRun ? 'DRY-RUN' : 'LIVE'}` +
        `${flags.limit !== undefined ? `, limit: ${flags.limit}` : ''}`,
    );

    // There are only ~18 atproto actors, so a single ordered pass is enough. The
    // stable ascending `id` sort keeps a `--limit` run deterministic — `id` is not
    // chronological across the cutover, but a scan wants a total order, not time.
    const actors: ActorRow[] = await scanActors(
      { protocol: 'atproto' },
      { limit: flags.limit ?? Number.MAX_SAFE_INTEGER },
    );

    logger.info(`[repairAtprotoActorHandles] ${actors.length} atproto actor(s) to scan`);

    for (const actor of actors) {
      counters.scanned += 1;

      let outcome: RepairOutcome;
      try {
        outcome = await repairActor(actor, flags);
      } catch (err) {
        // One bad actor never aborts the run.
        logger.warn('[repairAtprotoActorHandles] actor repair failed', { error: err });
        outcome = 'failed';
      }

      switch (outcome) {
        case 'repaired':
          counters.repaired += 1;
          break;
        case 'unchanged':
          counters.unchanged += 1;
          break;
        case 'failed':
          counters.failed += 1;
          break;
      }
    }

    const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
    logger.info(
      `[repairAtprotoActorHandles] done (${flags.dryRun ? 'DRY-RUN' : 'LIVE'}, ${elapsedSeconds}s): ` +
        `scanned ${counters.scanned}, repaired ${counters.repaired}, ` +
        `unchanged ${counters.unchanged}, failed ${counters.failed}`,
    );

    assertAdminRunComplete('repairAtprotoActorHandles', {
      failed: counters.failed,
    });
  } catch (error) {
    logger.error('[repairAtprotoActorHandles] failed', error);
    throw error;
  } finally {
    await mongoose.disconnect();
    await closePostgres();
  }
}

if (require.main === module) {
  // Exit deterministically: imported singletons (BullMQ Redis connections, media
  // cache workers) can keep the event loop alive, so the process would otherwise
  // sit RUNNING after the work completes. Mirrors the other one-shot scripts.
  repairAtprotoActorHandles()
    .then(() => process.exit(0))
    .catch((error) => {
      logger.error('[repairAtprotoActorHandles] unhandled failure', error);
      process.exit(1);
    });
}

export default repairAtprotoActorHandles;
