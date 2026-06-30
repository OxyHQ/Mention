/**
 * One-shot backfill: mirror header/banner images for ALREADY-imported federated
 * actors.
 *
 * #285 wired `resolveOxyExternalUser` to mirror a federated actor's banner into a
 * durable, PUBLIC Oxy asset (service-token media path) and store the file id on
 * `UserSettings.profileHeaderImage` — but only NEW actor resolutions get a banner
 * from then on. The ~15k EXISTING federated actors never re-resolve, so their
 * profiles stay banner-less until this runs.
 *
 * This script walks every `FederatedActor` that advertises a `headerUrl` and is
 * already linked to an Oxy user (`oxyUserId` set), and mirrors that banner
 * through the SAME `mirrorFederatedBanner` helper the live path uses (banner-only:
 * no full re-resolve, no re-PUT of `/users/resolve`). It is idempotent — by
 * default it SKIPS actors whose `UserSettings.profileHeaderImage` is already set,
 * so a re-run only fills the gaps. Set `BACKFILL_FORCE=true` to re-mirror every
 * actor regardless (e.g. to refresh stale banners).
 *
 * Throughput is bounded TWO ways so the run completes without tripping oxy-api's
 * rate limits (which OOM'd + 429'd an earlier concurrency-6 run):
 *   - a global rate gate (`BACKFILL_RATE_PER_MIN`, default 25) enforces a minimum
 *     interval between upload *starts* across the whole worker pool. 25/min stays
 *     under oxy-api's `POST /assets/service/federation` cap of 30 uploads/min and
 *     well under the global per-IP 1000-req/15-min limiter.
 *   - a bounded worker pool (`BACKFILL_CONCURRENCY`, default 1) caps how many
 *     mirrors hold a banner buffer at once (the prior OOM was concurrency 6).
 * With the rate gate doing the real throttling, concurrency 1 is plenty.
 *
 * Transient mirror failures (network blip, 429) are retried up to 3 attempts with
 * exponential backoff (each retry re-passes the rate gate); permanent failures
 * (remote 404/410, non-image) are NOT retried and counted separately as `dead`.
 *
 * Logs progress plus a final summary
 * (processed / stored / skipped-already-set / retried / failed / dead) and is
 * resumable via the idempotent skip check.
 *
 * Runnable as a Fargate one-shot post-deploy:
 *   bun packages/backend/dist/src/scripts/backfillFederatedBanners.js
 *   BACKFILL_FORCE=true bun packages/backend/dist/src/scripts/backfillFederatedBanners.js
 *   BACKFILL_RATE_PER_MIN=20 bun packages/backend/dist/src/scripts/backfillFederatedBanners.js
 */

import mongoose from 'mongoose';
import { connectToDatabase } from '../utils/database';
import { FederatedActor } from '../models/FederatedActor';
import UserSettings from '../models/UserSettings';
import { mirrorFederatedBanner } from '../connectors/identity';
import { logger } from '../utils/logger';

/** Actors scanned per page (stable ascending `_id` cursor pagination). */
const PAGE_SIZE = 500;

/** Re-mirror every actor's banner, even when one is already stored. */
const FORCE = process.env.BACKFILL_FORCE === 'true';

/** Retry attempts (incl. the first) for a transient (non-permanent) failure. */
const MAX_ATTEMPTS = 3;

/** Exponential backoff base; attempt N waits `BACKOFF_BASE_MS * 3^(N-1)` (2s, 6s, 18s). */
const BACKOFF_BASE_MS = 2000;

/**
 * Bounded fan-out of concurrent mirror operations. With the rate gate enforcing
 * the real throughput cap, this only bounds how many banner buffers are held in
 * memory at once. Defaults to 1 (the prior concurrency-6 run OOM'd).
 */
function getConcurrency(): number {
  const raw = Number.parseInt(process.env.BACKFILL_CONCURRENCY || '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 1;
}

/**
 * Maximum upload *starts* per minute across the whole pool. Kept under oxy-api's
 * 30/min federation-upload cap. Defaults to 25.
 */
function getRatePerMinute(): number {
  const raw = Number.parseInt(process.env.BACKFILL_RATE_PER_MIN || '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 25;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Global minimum-interval rate gate shared across the worker pool. `acquire()`
 * resolves only once at least `minIntervalMs` has elapsed since the previous
 * grant, so upload *starts* are spaced ≥ `60000 / ratePerMinute` ms apart
 * regardless of concurrency. Serializing the reservation (each `acquire` advances
 * `nextSlot` to `max(now, nextSlot) + minIntervalMs`) makes it a real cap rather
 * than a per-worker sleep that would drift under parallelism.
 */
class RateGate {
  private readonly minIntervalMs: number;
  private nextSlot = 0;

  constructor(ratePerMinute: number) {
    this.minIntervalMs = 60000 / ratePerMinute;
  }

  async acquire(): Promise<void> {
    const now = Date.now();
    const slot = Math.max(now, this.nextSlot);
    this.nextSlot = slot + this.minIntervalMs;
    const waitMs = slot - now;
    if (waitMs > 0) await sleep(waitMs);
  }
}

interface FederatedActorRow {
  _id: mongoose.Types.ObjectId;
  uri: string;
  headerUrl: string;
  oxyUserId: string;
}

interface BackfillCounters {
  processed: number;
  stored: number;
  skippedAlreadySet: number;
  retried: number;
  failed: number;
  dead: number;
}

/**
 * Mirror one actor's banner (unless its header image is already stored and we are
 * not forcing), passing the global rate gate before each attempt. Retries a
 * transient failure up to `MAX_ATTEMPTS` with exponential backoff; a permanent
 * failure (remote gone / non-image) is counted as `dead` and never retried.
 *
 * Mutates `counters` in place — called concurrently within a bounded pool, but
 * each branch touches a distinct counter increment on the single-threaded event
 * loop, so no synchronization is needed.
 */
async function processActor(
  actor: FederatedActorRow,
  counters: BackfillCounters,
  gate: RateGate,
): Promise<void> {
  if (!FORCE) {
    const existing = await UserSettings.findOne(
      { oxyUserId: actor.oxyUserId },
      { profileHeaderImage: 1 },
    ).lean<{ profileHeaderImage?: string } | null>();
    if (existing?.profileHeaderImage) {
      counters.skippedAlreadySet += 1;
      return;
    }
  }

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    // Every attempt — first try and each retry — passes the global rate gate so
    // backoff retries never burst past the upload cap.
    await gate.acquire();

    try {
      const result = await mirrorFederatedBanner(actor.headerUrl, actor.oxyUserId, actor.uri);
      if (result.ok) {
        counters.stored += 1;
        return;
      }
      if (result.permanent) {
        // Remote 404/410, non-image, oversized, or a non-http url — retrying will
        // never succeed. Count it as `dead` and stop.
        counters.dead += 1;
        return;
      }
      // Transient failure (network blip / 429 / upstream 5xx): back off and retry.
      if (attempt < MAX_ATTEMPTS) {
        counters.retried += 1;
        await sleep(BACKOFF_BASE_MS * 3 ** (attempt - 1));
        continue;
      }
      counters.failed += 1;
      return;
    } catch (error) {
      // A thrown error is treated as transient (the helper itself never throws on
      // a classified permanent failure — it returns `permanent: true`).
      if (attempt < MAX_ATTEMPTS) {
        counters.retried += 1;
        logger.warn(`[backfillFederatedBanners] mirror threw for ${actor.uri} (attempt ${attempt})`, {
          reason: error instanceof Error ? error.message : 'unknown',
        });
        await sleep(BACKOFF_BASE_MS * 3 ** (attempt - 1));
        continue;
      }
      counters.failed += 1;
      logger.warn(`[backfillFederatedBanners] mirror threw for ${actor.uri} (final)`, {
        reason: error instanceof Error ? error.message : 'unknown',
      });
      return;
    }
  }
}

/**
 * Run `worker` over `items` with at most `concurrency` in flight at once.
 */
async function runPool<T>(items: T[], concurrency: number, worker: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      await worker(items[index]);
    }
  });
  await Promise.all(runners);
}

async function backfillFederatedBanners(): Promise<void> {
  const startedAt = Date.now();
  const concurrency = getConcurrency();
  const ratePerMinute = getRatePerMinute();
  const gate = new RateGate(ratePerMinute);

  try {
    await connectToDatabase();
    logger.info(
      `[backfillFederatedBanners] connected to MongoDB; FORCE=${FORCE}, concurrency=${concurrency}, rate=${ratePerMinute}/min`,
    );

    // Actors that advertise a banner AND are linked to an Oxy user (so the banner
    // has an owner to upload it under). `oxyUserId` is sparse-indexed; the set is
    // immutable for this run (we only write `UserSettings`, never the actor), so
    // the ascending `_id` cursor never revisits a row.
    const baseFilter: Record<string, unknown> = {
      headerUrl: { $type: 'string', $ne: '' },
      oxyUserId: { $type: 'string', $ne: '' },
    };

    const totalCount = await FederatedActor.countDocuments(baseFilter);
    logger.info(`[backfillFederatedBanners] ${totalCount} federated actors with a banner to scan`);

    if (totalCount === 0) {
      logger.info('[backfillFederatedBanners] nothing to do');
      await mongoose.disconnect();
      return;
    }

    const counters: BackfillCounters = {
      processed: 0,
      stored: 0,
      skippedAlreadySet: 0,
      retried: 0,
      failed: 0,
      dead: 0,
    };
    let lastId: mongoose.Types.ObjectId | null = null;

    for (;;) {
      const pageFilter: Record<string, unknown> = { ...baseFilter };
      if (lastId) {
        pageFilter._id = { $gt: lastId };
      }

      const page = await FederatedActor.find(pageFilter, { _id: 1, uri: 1, headerUrl: 1, oxyUserId: 1 })
        .sort({ _id: 1 })
        .limit(PAGE_SIZE)
        .lean<FederatedActorRow[]>();

      if (page.length === 0) break;

      await runPool(page, concurrency, (actor) => processActor(actor, counters, gate));

      counters.processed += page.length;
      lastId = page[page.length - 1]._id;
      logger.info(
        `[backfillFederatedBanners] progress: processed ${counters.processed}/${totalCount}, stored ${counters.stored}, skipped-already-set ${counters.skippedAlreadySet}, retried ${counters.retried}, failed ${counters.failed}, dead ${counters.dead}`,
      );
    }

    const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
    logger.info(
      `[backfillFederatedBanners] done${FORCE ? ' (FORCE)' : ''}: processed ${counters.processed}, stored ${counters.stored}, skipped-already-set ${counters.skippedAlreadySet}, retried ${counters.retried}, failed ${counters.failed}, dead ${counters.dead} (${elapsedSeconds}s)`,
    );

    await mongoose.disconnect();
  } catch (error) {
    logger.error('[backfillFederatedBanners] failed', error);
    await mongoose.disconnect();
    process.exit(1);
  }
}

if (require.main === module) {
  backfillFederatedBanners()
    .then(() => process.exit(0))
    .catch((error) => {
      logger.error('[backfillFederatedBanners] unhandled failure', error);
      process.exit(1);
    });
}

export default backfillFederatedBanners;
