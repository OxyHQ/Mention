/**
 * Migration 0020: the identity of the blocklist review queue.
 *
 * `BlocklistProposal` is one row per domain, and two of the properties the
 * scheduled sweep is built on rest entirely on that being TRUE in the database
 * rather than merely intended:
 *
 *  - `blocklistproposals` UNIQUE `{ domain: 1 }` — the row's identity. It is
 *    what makes the sweep's per-domain upsert idempotent across overlapping
 *    runs, and it is the second of the two defences that stop a domain a person
 *    DECLINED from being resurrected: the sweep writes with a
 *    `status: { $ne: 'declined' }` filter, so a decline landing mid-run makes
 *    the upsert attempt an insert, which this constraint refuses. Without the
 *    index that write silently succeeds as a duplicate row, and a decision
 *    somebody made is quietly undone by a background job.
 *  - `{ status: 1, firstProposedAt: 1 }` — the review queue itself: everything
 *    still open, oldest first, so a proposal nobody has answered for months
 *    sorts to the top instead of being lost behind newer ones.
 *
 * Idempotent: `createIndex` with an identical spec is a no-op, and it creates
 * the collection on first run. Data-free — the collection is new, so the unique
 * constraint has nothing to conflict with.
 */

import mongoose from 'mongoose';
import { logger } from '../utils/logger';
import { MIGRATION_BLOCKLIST_PROPOSAL_INDEXES } from './constants';
import type { Migration } from './runner';

/**
 * Named here rather than read off a Mongoose model, because the review queue now
 * lives in Postgres (`blocklist_proposals`) and the model is gone. A landed
 * migration is frozen history: it repairs the indexes of a PRE-CUTOVER Mongo
 * collection, so it must keep naming what that collection was called at the
 * time and must not follow a live constant that could be renamed underneath it.
 */
const BLOCKLIST_PROPOSAL_COLLECTION = 'blocklistproposals';

export const migrationBlocklistProposalIndexes: Migration = {
  id: MIGRATION_BLOCKLIST_PROPOSAL_INDEXES,

  async run(db: mongoose.mongo.Db): Promise<void> {
    const queue = db.collection(BLOCKLIST_PROPOSAL_COLLECTION);
    await queue.createIndex({ domain: 1 }, { unique: true });
    await queue.createIndex({ status: 1, firstProposedAt: 1 });
    logger.info(
      `[migration] ensured indexes on ${queue.collectionName} ` +
        `{ domain: 1 } (unique) and { status: 1, firstProposedAt: 1 }`,
    );
  },
};
