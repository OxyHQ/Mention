/**
 * Migration 0019: the identity of a blocked-domain purge's history row.
 *
 * `BlockedDomainPurgeRun` is append-only history — what one run removed for one
 * domain — as opposed to `BlockedDomainPurge`, which is that domain's current
 * state. It exists because a domain can be blocked, purged, unblocked and
 * blocked again, and both results have to survive.
 *
 *  - `blockeddomainpurgeruns` UNIQUE `{ domain: 1, runId: 1 }` — one row per
 *    domain per run. WITHOUT it, a run that is retried after a failure or
 *    resumed after being killed appends a SECOND row for work it had already
 *    recorded, and every per-domain total silently doubles. That is the
 *    dangerous shape here: the numbers stay plausible, so nothing looks wrong.
 *  - `{ domain: 1, runAt: -1 }` — serves both queries this collection exists
 *    for: the latest run for a domain, and every run for a domain to sum.
 *
 * Idempotent: `createIndex` with an identical spec is a no-op, and it creates
 * the collection on first run. Data-free — the collection is new.
 */

import mongoose from 'mongoose';
import { logger } from '../utils/logger';
import { MIGRATION_BLOCKED_DOMAIN_PURGE_RUN_INDEXES } from './constants';
import BlockedDomainPurgeRun from '../models/BlockedDomainPurgeRun';
import type { Migration } from './runner';

export const migrationBlockedDomainPurgeRunIndexes: Migration = {
  id: MIGRATION_BLOCKED_DOMAIN_PURGE_RUN_INDEXES,

  async run(db: mongoose.mongo.Db): Promise<void> {
    const runs = db.collection(BlockedDomainPurgeRun.collection.collectionName);
    await runs.createIndex({ domain: 1, runId: 1 }, { unique: true });
    await runs.createIndex({ domain: 1, runAt: -1 });
    logger.info(
      `[migration] ensured indexes on ${runs.collectionName} ` +
        `{ domain: 1, runId: 1 } (unique) and { domain: 1, runAt: -1 }`,
    );
  },
};
