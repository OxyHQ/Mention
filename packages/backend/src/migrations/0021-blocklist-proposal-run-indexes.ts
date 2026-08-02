/**
 * Migration 0021: the identity and the schedule of the sweep's run history.
 *
 * `BlocklistProposalRun` is append-only history — one row per sweep of the
 * published blocklists — and it does double duty as the schedule itself.
 *
 *  - `blocklistproposalruns` UNIQUE `{ runId: 1 }` — one row per run, so a
 *    retried record can never append a second.
 *  - `{ startedAt: -1 }` — the ONLY query the scheduler makes: when did the last
 *    sweep start? It runs every few minutes on the elected leader, and it is
 *    what makes the weekly cadence survive a service that redeploys daily. A
 *    collection scan for it would grow with the history it is scanning.
 *
 * Idempotent: `createIndex` with an identical spec is a no-op, and it creates
 * the collection on first run. Data-free — the collection is new.
 */

import mongoose from 'mongoose';
import { logger } from '../utils/logger';
import { MIGRATION_BLOCKLIST_PROPOSAL_RUN_INDEXES } from './constants';
import BlocklistProposalRun from '../models/BlocklistProposalRun';
import type { Migration } from './runner';

export const migrationBlocklistProposalRunIndexes: Migration = {
  id: MIGRATION_BLOCKLIST_PROPOSAL_RUN_INDEXES,

  async run(db: mongoose.mongo.Db): Promise<void> {
    const runs = db.collection(BlocklistProposalRun.collection.collectionName);
    await runs.createIndex({ runId: 1 }, { unique: true });
    await runs.createIndex({ startedAt: -1 });
    logger.info(
      `[migration] ensured indexes on ${runs.collectionName} ` +
        `{ runId: 1 } (unique) and { startedAt: -1 }`,
    );
  },
};
