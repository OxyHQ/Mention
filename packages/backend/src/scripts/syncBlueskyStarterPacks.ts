/**
 * One-shot backfill: mirror existing atproto actors' PROFILE GRAPH extras — their
 * starter packs (`app.bsky.graph.starterpack`) and their feed generators
 * (`app.bsky.feed.generator`), both into native Mention records — into Mention.
 *
 * WHY
 *   Starter-pack + feed sync is discovered on profile view (the same lifecycle as
 *   post backfill — see `connectors/federatedProfileSync.ts`), so an atproto actor
 *   Mention resolved BEFORE this feature shipped has no mirrored packs/feeds until
 *   someone views their profile again. This sweep catches those actors up.
 *
 *   Despite the starter-pack-focused name, it runs the SAME orchestrator the live
 *   path does (`syncAtprotoProfileGraph`), so it also refreshes each actor's feed
 *   generators — the two are always discovered together.
 *
 * WHAT IT DOES
 *   Iterates every atproto `FederatedActor` that already carries a resolved
 *   `oxyUserId` (the no-orphan invariant — a pack/feed must be owned by a real Oxy
 *   user) and calls `syncAtprotoProfileGraph(actor.uri, actor.oxyUserId)`. That
 *   upserts each pack on `source.uri` and each feed generator on its AT-URI
 *   (idempotent — re-running never duplicates), minting any not-yet-seen member
 *   accounts through the shared federated-identity path.
 *
 * FLAGS (plain argv):
 *   --dry-run          enumerate the atproto actors that WOULD be synced (respecting
 *                      --actor / --limit) and report the scope; perform NO network
 *                      sync and write NOTHING (no upserts, no minted members).
 *   --limit N          cap the number of actors processed.
 *   --actor <did|handle>  restrict to one actor, matched on its `uri` (DID) or `acct`.
 *   --concurrency N    how many actors to sync in parallel (default 8, clamped 32).
 *
 * Idempotent + forward-only: batched by a stable ASCENDING `_id` cursor; a re-sync
 * upserts the same rows (no duplicates), so re-running is safe.
 *
 * RUN AS A FARGATE ONE-SHOT (post-deploy, in-VPC):
 *   ATPROTO_ENABLED=true bun packages/backend/dist/src/scripts/syncBlueskyStarterPacks.js --dry-run
 *   ATPROTO_ENABLED=true CONFIRM_ADMIN_MUTATION=syncBlueskyStarterPacks \
 *     bun packages/backend/dist/src/scripts/syncBlueskyStarterPacks.js --limit 50
 *
 * RUN OVER THE SSM TUNNEL (prod Mongo forwarded to 127.0.0.1:47017):
 *   MONGODB_URI='mongodb://127.0.0.1:47017/?directConnection=true' NODE_ENV=production \
 *   ATPROTO_ENABLED=true bun packages/backend/src/scripts/syncBlueskyStarterPacks.ts --dry-run --limit 20
 */

import mongoose from 'mongoose';
import { logger } from '../utils/logger';
import { countActors, scanActors, type ActorScanFilter } from '../db/federation/actorRepository';
import { connectPostgres, closePostgres } from '../db/postgres';
import { ATPROTO_ENABLED } from '../connectors/atproto/constants';
import { syncAtprotoProfileGraph } from '../connectors/atproto/profileGraph';
import { mapWithConcurrency, DEFAULT_CONCURRENCY, MAX_CONCURRENCY } from '../utils/concurrency';
import { assertAdminMutationAllowed } from './lib/adminScriptSafety';
import { assertAdminRunComplete } from './lib/adminScriptLifecycle';

/** Actors scanned per page (stable `_id` cursor pagination). */
const PAGE_SIZE = 500;

interface Flags {
  dryRun: boolean;
  limit?: number;
  actor?: string;
  concurrency: number;
}

/** The lean `FederatedActor` fields the sweep reads. */
interface AtprotoActorRow {
  id: string;
  uri: string;
  acct?: string;
  oxyUserId?: string;
}

interface Counters {
  scanned: number;
  synced: number;
  failed: number;
}

// --- argv parsing (plain, mirrors reingestBlueskyPosts) ----------------------

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

  const actor = readFlagValue(argv, '--actor')?.trim() || undefined;

  const rawConcurrency = readFlagValue(argv, '--concurrency');
  let concurrency = DEFAULT_CONCURRENCY;
  if (rawConcurrency !== undefined) {
    const parsed = Number.parseInt(rawConcurrency, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new Error(`--concurrency must be a positive integer (got "${rawConcurrency}")`);
    }
    concurrency = Math.min(parsed, MAX_CONCURRENCY);
  }

  return { dryRun, limit, actor, concurrency };
}

/** atproto actors with a resolved Oxy owner (+ optional single-actor scope). */
function buildFilter(actor: string | undefined): ActorScanFilter {
  return {
    protocol: 'atproto',
    hasOxyUserId: true,
    ...(actor ? { uriOrAcct: actor } : {}),
  };
}

async function syncBlueskyStarterPacks(): Promise<void> {
  const startedAt = Date.now();
  const flags = parseFlags(process.argv.slice(2));

  if (!ATPROTO_ENABLED) {
    // The graph sync talks to the Bluesky AppView through the atproto connector,
    // which is gated on ATPROTO_ENABLED — refuse loudly rather than silently no-op.
    throw new Error('ATPROTO_ENABLED must be "true" to run the Bluesky starter-pack sync');
  }

  const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/mention';
  const dbName = `mention-${process.env.NODE_ENV || 'development'}`;

  const counters: Counters = { scanned: 0, synced: 0, failed: 0 };
  let remaining = flags.limit;

  try {
    assertAdminMutationAllowed({
      scriptName: 'syncBlueskyStarterPacks',
      dryRun: flags.dryRun,
    });
    await mongoose.connect(mongoUri, { dbName });
    // Actors are in Postgres; the starter-pack rows this mints are still Mongo.
    await connectPostgres();
    const baseFilter = buildFilter(flags.actor);
    const total = await countActors(baseFilter);
    logger.info('[syncBlueskyStarterPacks] connected', {
      dryRun: flags.dryRun,
      concurrency: flags.concurrency,
      limit: flags.limit,
      count: total,
      narrowedScope: Boolean(flags.actor),
    });

    let lastId: string | undefined;
    for (;;) {
      if (remaining !== undefined && remaining <= 0) break;

      const pageLimit = remaining !== undefined ? Math.min(PAGE_SIZE, remaining) : PAGE_SIZE;
      const page: AtprotoActorRow[] = await scanActors(baseFilter, {
        afterId: lastId,
        limit: pageLimit,
      });
      if (page.length === 0) break;

      if (flags.dryRun) {
        // A dry-run only reports the SCOPE (which actors would be synced) — it runs
        // no AppView reads, mints no members, and writes nothing.
        for (const _actor of page) {
          counters.scanned += 1;
          if (remaining !== undefined) remaining -= 1;
          logger.info('[syncBlueskyStarterPacks] actor graph would be synchronized');
        }
      } else {
        const settled = await mapWithConcurrency(page, flags.concurrency, (actor) => {
          const owner = actor.oxyUserId;
          if (!owner) return Promise.resolve(false);
          // The XRPC/Oxy clients own their request deadlines. Await the mutating
          // graph sync so it cannot continue after a non-cancelling timeout race.
          return syncAtprotoProfileGraph(actor.uri, owner).then(() => true);
        });

        for (let i = 0; i < page.length; i++) {
          counters.scanned += 1;
          if (remaining !== undefined) remaining -= 1;
          const result = settled[i];
          if (result.status === 'fulfilled' && result.value) {
            counters.synced += 1;
          } else if (result.status === 'rejected') {
            const err = result.reason;
            logger.warn('[syncBlueskyStarterPacks] actor graph synchronization failed', {
              error: err,
            });
            counters.failed += 1;
          }
        }
      }

      lastId = page[page.length - 1].id;
      logger.info(
        `[syncBlueskyStarterPacks] progress: scanned ${counters.scanned}, synced ${counters.synced}, failed ${counters.failed}`,
      );
    }

    const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
    logger.info(
      `[syncBlueskyStarterPacks] done (${flags.dryRun ? 'DRY-RUN' : 'LIVE'}, ${elapsedSeconds}s): ` +
        `scanned ${counters.scanned}, synced ${counters.synced}, failed ${counters.failed}`,
    );

    assertAdminRunComplete('syncBlueskyStarterPacks', {
      failed: counters.failed,
    });
  } catch (error) {
    logger.error('[syncBlueskyStarterPacks] failed', error);
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
  syncBlueskyStarterPacks()
    .then(() => process.exit(0))
    .catch((error) => {
      logger.error('[syncBlueskyStarterPacks] unhandled failure', error);
      process.exit(1);
    });
}

export default syncBlueskyStarterPacks;
