/**
 * One-shot cleanup: TOMBSTONE `FederatedActor` rows whose remote actor is
 * permanently gone (HTTP 410 Gone) upstream.
 *
 * WHY
 *   Mention discovers a remote profile once and keeps its `FederatedActor` row
 *   forever — there is no push when a remote account is DELETED. A deleted
 *   Mastodon/fediverse account keeps surfacing in Mention (search, mentions,
 *   its cached posts) even though it no longer exists. The live path now handles
 *   this going forward: `ActorService.fetchRemoteActor` tombstones an actor the
 *   moment its actor fetch returns a definitive 410 (marks the row `suspended`
 *   and asks oxy-api to archive the linked identity via
 *   `POST /federation/actor-gone`, dropping it from search). But that only fires
 *   when the actor happens to be re-fetched. This script SWEEPS existing rows so
 *   already-dead actors are reconciled without waiting for an incidental refetch.
 *
 * WHAT IT DOES — per scanned actor:
 *   Re-fetches the actor via the SAME signed-fetch path the live code uses
 *   (`signedFetch(uri, AP_CONTENT_TYPE)`), then:
 *     - 410 Gone            → `tombstoned` (applies the SAME tombstone as the live
 *                             path: `actorService.tombstoneGoneActor` — suspend the
 *                             row + report-gone to oxy-api). Idempotent.
 *     - 2xx OK              → `still-live` (left completely untouched).
 *     - anything else       → `transient-failed` (404 [many servers 404 a live
 *                             account transiently], 5xx, network error, or the
 *                             per-actor timeout) — left untouched so a later run
 *                             can still recover it. ONLY a 410 is treated as gone.
 *   It NEVER deletes a `FederatedActor` document — posts, boosts and MTN records
 *   may still reference the actor (see the model doc). This is a tombstone sweep,
 *   not a purge (that is `purgeOwnDomainFederatedActors.ts`).
 *
 *   atproto (Bluesky) actors are excluded: a 410-on-actor-fetch is an
 *   ActivityPub notion — an atproto actor is a DID with no AP actor endpoint to
 *   return 410 — so the scan is scoped to `protocol != 'atproto'` (which also
 *   catches legacy rows written before the `protocol` field existed).
 *
 * TARGETING (keep the first run cheap)
 *   By default the scan is restricted to actors most likely to be dead:
 *   `postsCount: 0` (or missing) — a profile we resolved but that has no content
 *   is the cheapest, highest-signal candidate. Pass `--all` to scan every
 *   (non-atproto) actor.
 *
 * FLAGS (plain argv):
 *   --dry-run          log what WOULD be tombstoned; write nothing (no Mongo
 *                      suspend, no oxy-api archive call). The re-fetch still runs
 *                      so the summary is accurate.
 *   --limit N          cap the number of actors processed (a canary budget).
 *   --actor <uri>      restrict to one actor by its stored `federated_actors.uri`.
 *   --all              scan every non-atproto actor, not just `postsCount: 0`.
 *   --concurrency N    how many actors to probe in parallel (default 8, clamped to
 *                      32). The sweep is I/O-bound (signed actor re-fetch + the
 *                      oxy-api actor-gone round-trip), so a small pool overlaps the
 *                      network waits for ~8-10x wall-clock. Keep it conservative to
 *                      avoid hammering oxy-api's actor-gone endpoint.
 *
 * Idempotent + forward-only: batched by a stable ASCENDING `id` cursor; a
 * tombstoned actor re-fetched on a second run 410s again and re-applies the same
 * (idempotent) tombstone, so re-running is safe.
 *
 * RUN AS A FARGATE ONE-SHOT (post-deploy, in-VPC):
 *   bun packages/backend/dist/src/scripts/pruneGoneFederatedActors.js --dry-run
 *   CONFIRM_ADMIN_MUTATION=pruneGoneFederatedActors \
 *     bun packages/backend/dist/src/scripts/pruneGoneFederatedActors.js --limit 200
 *
 * RUN OVER THE SSM TUNNEL (prod Mongo forwarded to 127.0.0.1:47017):
 *   MONGODB_URI='mongodb://127.0.0.1:47017/?directConnection=true' \
 *   NODE_ENV=production \
 *   bun packages/backend/src/scripts/pruneGoneFederatedActors.ts --dry-run --limit 50
 *   (NODE_ENV=production selects the `mention-production` DB; drop --dry-run to
 *   write. The tunnel is fine for this cursor-paged sweep.)
 */

import mongoose from 'mongoose';
import {
  countActors,
  scanActors,
  type ActorScanFilter,
} from '../db/federation/actorRepository';
import { connectPostgres, closePostgres } from '../db/postgres';
import { connectToDatabase } from '../utils/database';
import { actorService } from '../connectors/activitypub/actor.service';
import { signedFetch } from '../connectors/activitypub/helpers';
import { AP_CONTENT_TYPE } from '../connectors/activitypub/constants';
import { logger } from '../utils/logger';
import { mapWithConcurrency, DEFAULT_CONCURRENCY, MAX_CONCURRENCY } from '../utils/concurrency';
import { assertAdminMutationAllowed } from './lib/adminScriptSafety';
import {
  assertAdminRunComplete,
  closeAdminScriptResources,
} from './lib/adminScriptLifecycle';

/** Actors scanned per page (stable `id` cursor pagination). */
const PAGE_SIZE = 500;

/**
 * Hard wall-clock cap on the read-only actor re-fetch. The tombstone write is
 * deliberately outside the race so a losing Promise cannot mutate later.
 */
const ACTOR_PROBE_TIMEOUT_MS = 30_000;

/** Per-actor re-fetch classification. Only `gone` (410) triggers a tombstone. */
type ScanOutcome = 'gone' | 'live' | 'transient';

interface Flags {
  dryRun: boolean;
  limit?: number;
  actor?: string;
  all: boolean;
  concurrency: number;
}

/** The `federated_actors` fields the sweep reads. */
interface ActorRow {
  id: string;
  uri: string;
  acct: string;
}

interface Counters {
  scanned: number;
  tombstoned: number;
  stillLive: number;
  transientFailed: number;
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
  const all = argv.includes('--all');

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

  return { dryRun, limit, actor, all, concurrency };
}

// --- per-actor probe ---------------------------------------------------------

/** Distinct rejection raised by {@link withActorTimeout} when a probe exceeds the cap. */
class ActorProbeTimeoutError extends Error {
  constructor(ms: number) {
    super(`actor probe exceeded ${ms}ms hard timeout`);
    this.name = 'ActorProbeTimeoutError';
  }
}

/**
 * Race only the read-only actor probe. The tombstone mutation remains outside
 * this race because a timed-out Promise would otherwise keep running and could
 * write after the caller had counted it as failed.
 */
function withActorTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ActorProbeTimeoutError(ms)), ms);
  });
  return Promise.race([work, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * Re-fetch the actor via the SAME signed-fetch path the live code uses and
 * classify the result. ONLY a definitive 410 is `gone`; a 2xx is `live`; every
 * other status (incl. 404), a network error, or a malformed URI is `transient`.
 */
async function probeActor(uri: string): Promise<ScanOutcome> {
  let res: Response;
  try {
    res = await signedFetch(uri, AP_CONTENT_TYPE);
  } catch (err) {
    logger.warn('[pruneGoneFederatedActors] actor probe failed', { error: err });
    return 'transient';
  }

  if (res.status === 410) return 'gone';
  if (res.ok) return 'live';

  logger.info('[pruneGoneFederatedActors] actor probe returned a non-gone status', {
    status: res.status,
  });
  return 'transient';
}

/**
 * Probe one actor and, on a definitive 410, apply the SAME tombstone as the live
 * path (`actorService.tombstoneGoneActor`: suspend the row + report-gone to
 * oxy-api). Dry-run reports the intended tombstone without writing.
 */
async function processActor(actor: ActorRow, flags: Flags): Promise<ScanOutcome> {
  const outcome = await withActorTimeout(
    probeActor(actor.uri),
    ACTOR_PROBE_TIMEOUT_MS,
  );
  if (outcome !== 'gone') return outcome;

  logger.info('[pruneGoneFederatedActors] confirmed-gone actor processed', {
    dryRun: flags.dryRun,
  });
  if (!flags.dryRun) {
    await actorService.tombstoneGoneActor(actor.uri);
  }
  return 'gone';
}

// --- scan driver -------------------------------------------------------------

/**
 * Build the Mongo filter: always non-atproto actors (410-on-actor-fetch is an AP
 * notion). An explicit `--actor <uri>` targets that one actor regardless of its
 * post count; otherwise the scan is restricted to `postsCount: 0` (or missing) —
 * the cheapest, highest-signal candidates — unless `--all` widens it to every
 * (non-atproto) actor.
 */
function buildFilter(flags: Flags): ActorScanFilter {
  if (flags.actor) return { protocolNot: 'atproto', uri: flags.actor };
  return { protocolNot: 'atproto', ...(flags.all ? {} : { zeroPostsCount: true }) };
}

async function pruneGoneFederatedActors(): Promise<void> {
  const startedAt = Date.now();
  const flags = parseFlags(process.argv.slice(2));

  const counters: Counters = { scanned: 0, tombstoned: 0, stillLive: 0, transientFailed: 0 };
  let remaining = flags.limit;

  try {
    assertAdminMutationAllowed({
      scriptName: 'pruneGoneFederatedActors',
      dryRun: flags.dryRun,
    });
    await connectToDatabase();
    // Actor rows are in Postgres; the Mongo connection stays for the tombstone
    // path's other reads.
    await connectPostgres();
    const scope = flags.actor ? `actor ${flags.actor}` : flags.all ? 'all' : 'postsCount:0';
    logger.info(
      `[pruneGoneFederatedActors] connected — mode: ${flags.dryRun ? 'DRY-RUN' : 'LIVE'}, ` +
        `scope: ${scope}, concurrency: ${flags.concurrency}` +
        `${flags.limit !== undefined ? `, limit: ${flags.limit}` : ''}`,
    );

    const baseFilter = buildFilter(flags);
    const total = await countActors(baseFilter);
    logger.info(`[pruneGoneFederatedActors] ${total} candidate actor(s) to scan`);

    let lastId: string | undefined;

    for (;;) {
      if (remaining !== undefined && remaining <= 0) break;

      const pageLimit = remaining !== undefined ? Math.min(PAGE_SIZE, remaining) : PAGE_SIZE;
      const page: ActorRow[] = await scanActors(baseFilter, { afterId: lastId, limit: pageLimit });
      if (page.length === 0) break;

      // The page is already sliced to at most the remaining budget (`pageLimit`), so
      // probing the WHOLE page in a bounded pool can never overshoot `--limit`. Each
      // actor's read-only probe stays bounded; a tombstone mutation is awaited to
      // completion so it cannot continue after a reported timeout.
      const settledResults = await mapWithConcurrency(page, flags.concurrency, (actor) =>
        processActor(actor, flags),
      );

      // Tally sequentially in `id` order AFTER the pool drains: every counter and
      // the shared budget are mutated exactly once per actor on a single call
      // stack, so no concurrent update can race or double-count.
      for (let i = 0; i < page.length; i++) {
        counters.scanned += 1;
        if (remaining !== undefined) remaining -= 1;

        const settled = settledResults[i];
        let outcome: ScanOutcome;
        if (settled.status === 'fulfilled') {
          outcome = settled.value;
        } else {
          // One bad actor never aborts the sweep; treat it as transient so a later
          // run can still reconcile it. A timeout is the defence-in-depth guard
          // against an unbounded await hanging the whole run.
          const err = settled.reason;
          if (err instanceof ActorProbeTimeoutError) {
            logger.warn('[pruneGoneFederatedActors] actor probe timed out; skipping', {
              durationMs: ACTOR_PROBE_TIMEOUT_MS,
            });
          } else {
            logger.warn('[pruneGoneFederatedActors] actor probe threw; skipping', {
              error: err,
            });
          }
          outcome = 'transient';
        }

        switch (outcome) {
          case 'gone':
            counters.tombstoned += 1;
            break;
          case 'live':
            counters.stillLive += 1;
            break;
          case 'transient':
            counters.transientFailed += 1;
            break;
        }
      }

      lastId = page[page.length - 1].id;
      logger.info(
        `[pruneGoneFederatedActors] progress: scanned ${counters.scanned}, tombstoned ${counters.tombstoned}, ` +
          `still-live ${counters.stillLive}, transient-failed ${counters.transientFailed}`,
      );
    }

    const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
    logger.info(
      `[pruneGoneFederatedActors] done (${flags.dryRun ? 'DRY-RUN' : 'LIVE'}, ${elapsedSeconds}s): ` +
        `scanned ${counters.scanned}, tombstoned ${counters.tombstoned}, ` +
        `still-live ${counters.stillLive}, transient-failed ${counters.transientFailed}`,
    );

    assertAdminRunComplete('pruneGoneFederatedActors', {
      transientFailed: counters.transientFailed,
    });
  } catch (error) {
    logger.error('[pruneGoneFederatedActors] failed', error);
    throw error;
  } finally {
    await closeAdminScriptResources();
    await mongoose.disconnect();
    await closePostgres();
  }
}

if (require.main === module) {
  // Exit deterministically: imported singletons (BullMQ Redis connections, media
  // cache workers) can keep the event loop alive, so the process would otherwise
  // sit RUNNING after the work completes. Mirrors the other one-shot scripts.
  pruneGoneFederatedActors()
    .then(() => process.exit(0))
    .catch((error) => {
      logger.error('[pruneGoneFederatedActors] unhandled failure', error);
      process.exit(1);
    });
}

export default pruneGoneFederatedActors;
