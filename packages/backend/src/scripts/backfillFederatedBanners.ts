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
 * Throttled with a bounded worker pool (default 6; `BACKFILL_CONCURRENCY`) so we
 * neither hammer remote instances nor the Oxy asset API. Logs progress plus a
 * final summary (processed / stored / skipped-already-set / failed) and is
 * resumable via the idempotent skip check.
 *
 * Runnable as a Fargate one-shot post-deploy:
 *   bun packages/backend/dist/src/scripts/backfillFederatedBanners.js
 *   BACKFILL_FORCE=true bun packages/backend/dist/src/scripts/backfillFederatedBanners.js
 *   BACKFILL_CONCURRENCY=10 bun packages/backend/dist/src/scripts/backfillFederatedBanners.js
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

/**
 * Bounded fan-out of concurrent mirror operations. Each mirror is a remote
 * download + a service-token upload, so the cap keeps us from hammering remote
 * instances or the Oxy asset API.
 */
function getConcurrency(): number {
  const raw = Number.parseInt(process.env.BACKFILL_CONCURRENCY || '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 6;
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
  failed: number;
}

/**
 * Mirror one actor's banner (unless its header image is already stored and we are
 * not forcing). Mutates `counters` in place — called concurrently within a
 * bounded pool, but each branch touches a distinct counter increment on the
 * single-threaded event loop, so no synchronization is needed.
 */
async function processActor(actor: FederatedActorRow, counters: BackfillCounters): Promise<void> {
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

  try {
    const stored = await mirrorFederatedBanner(actor.headerUrl, actor.oxyUserId, actor.uri);
    if (stored) {
      counters.stored += 1;
    } else {
      counters.failed += 1;
    }
  } catch (error) {
    counters.failed += 1;
    logger.warn(`[backfillFederatedBanners] mirror threw for ${actor.uri}`, {
      reason: error instanceof Error ? error.message : 'unknown',
    });
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

  try {
    await connectToDatabase();
    logger.info(
      `[backfillFederatedBanners] connected to MongoDB; FORCE=${FORCE}, concurrency=${concurrency}`,
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
      failed: 0,
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

      await runPool(page, concurrency, (actor) => processActor(actor, counters));

      counters.processed += page.length;
      lastId = page[page.length - 1]._id;
      logger.info(
        `[backfillFederatedBanners] progress: processed ${counters.processed}/${totalCount}, stored ${counters.stored}, skipped-already-set ${counters.skippedAlreadySet}, failed ${counters.failed}`,
      );
    }

    const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
    logger.info(
      `[backfillFederatedBanners] done${FORCE ? ' (FORCE)' : ''}: processed ${counters.processed}, stored ${counters.stored}, skipped-already-set ${counters.skippedAlreadySet}, failed ${counters.failed} (${elapsedSeconds}s)`,
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
