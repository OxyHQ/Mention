/**
 * Migration 0017: indexes for the administrative sweep's re-fetch failure log.
 *
 * `RepairFetchFailure` records WHY each post's source re-fetch failed, so the
 * transient tail can be retried without re-walking the corpus. The schema
 * declares both indexes, but `autoIndex`/`autoCreate` are OFF in production (see
 * `utils/database.ts`), so this migration is the only thing that creates them.
 *
 *  - `repairfetchfailures` UNIQUE `{ script: 1, postId: 1 }` — the row's
 *    identity. The sweep upserts on that pair after every page; WITHOUT the
 *    constraint, each run that re-fails the same post inserts another row, and a
 *    log meant to be bounded by the number of distinct failing posts grows
 *    without limit while the targeting query returns the same post repeatedly.
 *  - `repairfetchfailures` `{ script: 1, reason: 1 }` — the ONE read this
 *    collection exists to serve ("every post this sweep failed for a retryable
 *    reason"). Without it that read is a collection scan, which is a poor
 *    foundation for the cheap targeted retry the log is supposed to enable.
 *
 * Idempotent: `createIndex` with an identical spec is a no-op, and it creates the
 * `repairfetchfailures` collection on first run. Data-free — the collection is
 * new, so the unique constraint has nothing to conflict with.
 */

import mongoose from 'mongoose';
import { logger } from '../utils/logger';
import { MIGRATION_REPAIR_FETCH_FAILURE_INDEXES } from './constants';
import { RepairFetchFailure } from '../models/RepairFetchFailure';
import type { Migration } from './runner';

export const migrationRepairFetchFailureIndexes: Migration = {
  id: MIGRATION_REPAIR_FETCH_FAILURE_INDEXES,

  async run(db: mongoose.mongo.Db): Promise<void> {
    const failures = db.collection(RepairFetchFailure.collection.collectionName);
    await failures.createIndex({ script: 1, postId: 1 }, { unique: true });
    await failures.createIndex({ script: 1, reason: 1 });
    logger.info(
      `[migration] ensured indexes on ${failures.collectionName} ` +
        `{ script: 1, postId: 1 } (unique) + { script: 1, reason: 1 }`,
    );
  },
};
