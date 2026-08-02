/**
 * Migration 0018: the identity of the blocked-domain purge ledger.
 *
 * `BlockedDomainPurge` is what makes "purge what was NEWLY blocked" a set
 * difference rather than a re-scan of every domain ever blocked, and what makes
 * an automatic deletion auditable afterwards. Both rest on `{domain}` addressing
 * exactly ONE row.
 *
 *  - `blockeddomainpurges` UNIQUE `{ domain: 1 }` — the ledger's identity. The
 *    reconciler upserts per domain; WITHOUT the constraint, two overlapping
 *    deploy one-shots can each insert their own row for the same domain, and the
 *    next reconciliation then reads whichever it happens to find. That is the
 *    invisible failure: a domain recorded as already purged while its content is
 *    still served, or purged twice under two different run ids so the audit
 *    record no longer says what actually happened.
 *  - `{ state: 1, claimedAt: 1 }` — served by the stale-claim re-arm sweep,
 *    which is what lets a run killed mid-deploy be retried rather than leaving
 *    its domains claimed forever.
 *
 * Idempotent: `createIndex` with an identical spec is a no-op, and it creates
 * the collection on first run. Data-free — the collection is new, so the unique
 * constraint has nothing to conflict with.
 */

import mongoose from 'mongoose';
import { logger } from '../utils/logger';
import { MIGRATION_BLOCKED_DOMAIN_PURGE_INDEXES } from './constants';
import type { Migration } from './runner';

/**
 * Named literally rather than read off a Mongoose model, which the Postgres port
 * deleted. A landed migration is FROZEN HISTORY: it repairs the indexes of a
 * pre-cutover Mongo collection, so it must keep naming what that collection was
 * called at the time and must not follow a live constant that could be renamed
 * underneath it. Same treatment `0012` got when the MTN models went.
 */
const BLOCKED_DOMAIN_PURGE_COLLECTION = 'blockeddomainpurges';


export const migrationBlockedDomainPurgeIndexes: Migration = {
  id: MIGRATION_BLOCKED_DOMAIN_PURGE_INDEXES,

  async run(db: mongoose.mongo.Db): Promise<void> {
    const ledger = db.collection(BLOCKED_DOMAIN_PURGE_COLLECTION);
    await ledger.createIndex({ domain: 1 }, { unique: true });
    await ledger.createIndex({ state: 1, claimedAt: 1 });
    logger.info(
      `[migration] ensured indexes on ${ledger.collectionName} ` +
        `{ domain: 1 } (unique) and { state: 1, claimedAt: 1 }`,
    );
  },
};
