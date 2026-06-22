/**
 * One-shot backfill: replay the CURRENT endorsement state of every starter pack
 * and account list into Oxy's recommendation graph (`POST /app-signals/ingest`).
 *
 * Why: endorsement pushes are only instrumented at membership-mutation call
 * sites, so packs/lists that existed BEFORE this feature shipped have never been
 * reported. This script enqueues a desired-state re-sync for each, idempotently.
 *
 * It is desired-state and idempotent (re-running re-pushes the same edges; Oxy
 * treats re-adds as no-ops), cursor-paged by ascending `_id` over each
 * collection (the scanned set is stable — we only read membership), and routed
 * through {@link EndorsementSignalService.syncScope} so it shares the exact same
 * outbox/push path as live mutations (failed scopes are left pending for the
 * drain job, never dropped).
 *
 * Runnable as a Fargate one-shot post-deploy:
 *   node dist/scripts/backfillEndorsements.js
 */

import mongoose from 'mongoose';
import StarterPack from '../models/StarterPack';
import AccountList from '../models/AccountList';
import { endorsementSignalService } from '../services/EndorsementSignalService';
import EndorsementOutbox from '../models/EndorsementOutbox';
import type { EndorsementSource } from '../models/EndorsementOutbox';
import { logger } from '../utils/logger';

/** Scopes processed per page (stable `_id` cursor pagination). */
const PAGE_SIZE = 200;

interface ScopeRow {
  _id: mongoose.Types.ObjectId;
}

/**
 * A model's `_id`-cursor page fetcher. Closing over the concrete model avoids
 * unifying two different Mongoose models' incompatible `find` overloads.
 */
type ScopePageFetcher = (
  lastId: mongoose.Types.ObjectId | null,
) => Promise<ScopeRow[]>;

const fetchStarterPackPage: ScopePageFetcher = (lastId) => {
  const filter: Record<string, unknown> = {};
  if (lastId) filter._id = { $gt: lastId };
  return StarterPack.find(filter, { _id: 1 })
    .sort({ _id: 1 })
    .limit(PAGE_SIZE)
    .lean<ScopeRow[]>();
};

const fetchAccountListPage: ScopePageFetcher = (lastId) => {
  const filter: Record<string, unknown> = {};
  if (lastId) filter._id = { $gt: lastId };
  return AccountList.find(filter, { _id: 1 })
    .sort({ _id: 1 })
    .limit(PAGE_SIZE)
    .lean<ScopeRow[]>();
};

/**
 * Backfill one collection's scopes. Pages by ascending `_id`, calling
 * `syncScope` for each. Returns the number of scopes processed.
 */
async function backfillCollection(
  source: EndorsementSource,
  fetchPage: ScopePageFetcher,
): Promise<number> {
  let lastId: mongoose.Types.ObjectId | null = null;
  let processed = 0;

  for (;;) {
    const page = await fetchPage(lastId);
    if (page.length === 0) break;

    for (const row of page) {
      await endorsementSignalService.syncScope(source, String(row._id));
      processed += 1;
    }

    lastId = page[page.length - 1]._id;
    logger.info(`[backfillEndorsements] ${source}: processed ${processed}`);
  }

  return processed;
}

async function backfillEndorsements(): Promise<void> {
  const startedAt = Date.now();
  const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/mention';
  const dbName = `mention-${process.env.NODE_ENV || 'development'}`;

  try {
    await mongoose.connect(mongoUri, { dbName });
    logger.info(`[backfillEndorsements] connected to MongoDB (${dbName})`);

    const packs = await backfillCollection('starterPack', fetchStarterPackPage);
    const lists = await backfillCollection('accountList', fetchAccountListPage);

    // Report how many rows are still pending (failed pushes) so the operator
    // knows whether the drain job has remaining work.
    const pending = await EndorsementOutbox.countDocuments({ status: 'pending' });

    const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
    logger.info(
      `[backfillEndorsements] done: starterPacks=${packs} accountLists=${lists} ` +
      `pendingOutboxRows=${pending} (${elapsedSeconds}s)`,
    );

    await mongoose.disconnect();
    process.exit(0);
  } catch (error) {
    logger.error('[backfillEndorsements] failed', error);
    await mongoose.disconnect();
    process.exit(1);
  }
}

if (require.main === module) {
  backfillEndorsements();
}

export default backfillEndorsements;
