/**
 * One-shot backfill: mirror existing atproto actors' PROFILE GRAPH extras — their
 * starter packs (`app.bsky.graph.starterpack`, functional import) and their feed
 * generators (`app.bsky.feed.generator`, read-only references) — into Mention.
 *
 * WHY
 *   Starter-pack + feed sync is discovered on profile view (the same lifecycle as
 *   post backfill — see `connectors/federatedProfileSync.ts`), so an atproto actor
 *   Mention resolved BEFORE this feature shipped has no mirrored packs/feeds until
 *   someone views their profile again. This sweep catches those actors up.
 *
 *   Despite the starter-pack-focused name, it runs the SAME orchestrator the live
 *   path does (`syncAtprotoProfileGraph`), so it also refreshes each actor's
 *   external feed references — the two are always discovered together.
 *
 * WHAT IT DOES
 *   Iterates every atproto `FederatedActor` that already carries a resolved
 *   `oxyUserId` (the no-orphan invariant — a pack/feed must be owned by a real Oxy
 *   user) and calls `syncAtprotoProfileGraph(actor.uri, actor.oxyUserId)`. That
 *   upserts each pack on `source.uri` (idempotent — re-running never duplicates)
 *   and each feed reference on its AT-URI, minting any not-yet-seen member accounts
 *   through the shared federated-identity path.
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
 *   ATPROTO_ENABLED=true bun packages/backend/dist/src/scripts/syncBlueskyStarterPacks.js --limit 50
 *   ATPROTO_ENABLED=true bun packages/backend/dist/src/scripts/syncBlueskyStarterPacks.js   # full sweep
 *
 * RUN OVER THE SSM TUNNEL (prod Mongo forwarded to 127.0.0.1:47017):
 *   MONGODB_URI='mongodb://127.0.0.1:47017/?directConnection=true' NODE_ENV=production \
 *   ATPROTO_ENABLED=true bun packages/backend/src/scripts/syncBlueskyStarterPacks.ts --dry-run --limit 20
 */

import mongoose from 'mongoose';
import { logger } from '../utils/logger';
import FederatedActor from '../models/FederatedActor';
import { ATPROTO_ENABLED } from '../connectors/atproto/constants';
import { syncAtprotoProfileGraph } from '../connectors/atproto/profileGraph';
import { mapWithConcurrency, DEFAULT_CONCURRENCY, MAX_CONCURRENCY } from '../utils/concurrency';

/** Actors scanned per page (stable `_id` cursor pagination). */
const PAGE_SIZE = 500;

/**
 * Hard per-actor wall-clock cap. Every network call inside the graph sync is
 * individually bounded by the XRPC client, but this guarantees one slow actor can
 * never freeze the sweep — a timed-out actor is counted `failed` and skipped.
 */
const ACTOR_TIMEOUT_MS = 120_000;

interface Flags {
  dryRun: boolean;
  limit?: number;
  actor?: string;
  concurrency: number;
}

/** The lean `FederatedActor` fields the sweep reads. */
interface AtprotoActorRow {
  _id: mongoose.Types.ObjectId;
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

/** Distinct rejection raised by {@link withActorTimeout} when an actor exceeds the cap. */
class ActorTimeoutError extends Error {
  constructor(ms: number) {
    super(`actor sync exceeded ${ms}ms hard timeout`);
    this.name = 'ActorTimeoutError';
  }
}

/**
 * Race one actor's sync against a hard timeout so a single hung remote can never
 * freeze the batch. The timer is ALWAYS cleared when the sync settles.
 */
function withActorTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ActorTimeoutError(ms)), ms);
  });
  return Promise.race([work, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/** Build the Mongo filter: atproto actors with a resolved Oxy owner (+ optional single-actor scope). */
function buildFilter(actor: string | undefined): Record<string, unknown> {
  const filter: Record<string, unknown> = {
    protocol: 'atproto',
    oxyUserId: { $exists: true, $ne: null },
  };
  if (actor) filter.$or = [{ uri: actor }, { acct: actor }];
  return filter;
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
    await mongoose.connect(mongoUri, { dbName });
    const baseFilter = buildFilter(flags.actor);
    const total = await FederatedActor.countDocuments(baseFilter);
    logger.info(
      `[syncBlueskyStarterPacks] connected to MongoDB (${dbName}) — mode: ${flags.dryRun ? 'DRY-RUN' : 'LIVE'}, ` +
        `concurrency: ${flags.concurrency}${flags.limit !== undefined ? `, limit: ${flags.limit}` : ''}; ` +
        `${total} atproto actor(s) with a resolved Oxy owner${flags.actor ? ` (actor ${flags.actor})` : ''}`,
    );

    let lastId: mongoose.Types.ObjectId | null = null;
    for (;;) {
      if (remaining !== undefined && remaining <= 0) break;

      const pageFilter: Record<string, unknown> = { ...baseFilter };
      if (lastId) pageFilter._id = { $gt: lastId };

      const pageLimit = remaining !== undefined ? Math.min(PAGE_SIZE, remaining) : PAGE_SIZE;
      const page = await FederatedActor.find(pageFilter, { _id: 1, uri: 1, acct: 1, oxyUserId: 1 })
        .sort({ _id: 1 })
        .limit(pageLimit)
        .lean<AtprotoActorRow[]>();
      if (page.length === 0) break;

      if (flags.dryRun) {
        // A dry-run only reports the SCOPE (which actors would be synced) — it runs
        // no AppView reads, mints no members, and writes nothing.
        for (const actor of page) {
          counters.scanned += 1;
          if (remaining !== undefined) remaining -= 1;
          logger.info(
            `[syncBlueskyStarterPacks] WOULD sync graph for ${actor.acct ?? actor.uri} (oxyUserId=${actor.oxyUserId})`,
          );
        }
      } else {
        const settled = await mapWithConcurrency(page, flags.concurrency, (actor) => {
          const owner = actor.oxyUserId;
          if (!owner) return Promise.resolve(false);
          return withActorTimeout(syncAtprotoProfileGraph(actor.uri, owner), ACTOR_TIMEOUT_MS).then(() => true);
        });

        for (let i = 0; i < page.length; i++) {
          const actor = page[i];
          counters.scanned += 1;
          if (remaining !== undefined) remaining -= 1;
          const result = settled[i];
          if (result.status === 'fulfilled' && result.value) {
            counters.synced += 1;
          } else if (result.status === 'rejected') {
            const err = result.reason;
            const message = err instanceof Error ? err.message : String(err);
            logger.warn(`[syncBlueskyStarterPacks] sync failed for ${actor.acct ?? actor.uri}: ${message}`);
            counters.failed += 1;
          }
        }
      }

      lastId = page[page.length - 1]._id;
      logger.info(
        `[syncBlueskyStarterPacks] progress: scanned ${counters.scanned}, synced ${counters.synced}, failed ${counters.failed}`,
      );
    }

    const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
    logger.info(
      `[syncBlueskyStarterPacks] done (${flags.dryRun ? 'DRY-RUN' : 'LIVE'}, ${elapsedSeconds}s): ` +
        `scanned ${counters.scanned}, synced ${counters.synced}, failed ${counters.failed}`,
    );

    await mongoose.disconnect();
  } catch (error) {
    logger.error('[syncBlueskyStarterPacks] failed', error);
    await mongoose.disconnect();
    process.exit(1);
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
