/**
 * Migration 0022: the indexes behind Lanes' two new collections.
 *
 * `lanes` — a publisher's carriageways:
 *  - `{ ownerType: 1, ownerId: 1, createdAt: -1 }` — the management screen's own
 *    list, newest first.
 *  - `{ ownerType: 1, ownerId: 1, nameLower: 1 }` UNIQUE — one name per
 *    publisher. This constraint IS the 409 on create: the cap's
 *    `countDocuments` is not a lock, so two concurrent creates of the same name
 *    are stopped here or not at all.
 *  - `{ ownerType: 1, ownerId: 1, displayMode: 1 }` — the exclusion lookup that
 *    runs on EVERY profile (and later channel) feed request, to find the lanes
 *    whose posts must not appear on the main tab.
 *
 * `lanemutes` — one reader silencing one lane:
 *  - `{ viewerOxyUserId: 1, laneId: 1 }` UNIQUE — the row's identity, which is
 *    what makes `POST /lanes/:id/mute` idempotent.
 *  - `{ viewerOxyUserId: 1, createdAt: -1 }` — the reader's list, loaded once
 *    per feed request and rendered by the settings screen.
 *
 * The schemas declare all five, but `autoIndex`/`autoCreate` are OFF in
 * production (see `utils/database.ts`), so this migration is the only thing that
 * creates them.
 *
 * Idempotent and data-free: `createIndex` with an identical spec is a no-op, it
 * creates the collection on first run, and both collections are new — so the two
 * unique constraints have nothing to conflict with.
 *
 * Deliberately separate from `0023-post-lane-index`: that one touches `posts`,
 * the only large collection involved, and it has to be observable and revertible
 * on its own.
 */

import mongoose from 'mongoose';
import { logger } from '../utils/logger';
import { MIGRATION_LANE_INDEXES } from './constants';
import type { Migration } from './runner';

/**
 * Named here rather than read off a Mongoose model, because lanes now live in
 * Postgres (`lanes`, `lane_mutes`) and the models are gone. A landed migration
 * is frozen history: it repairs the indexes of a PRE-CUTOVER Mongo collection,
 * so it must keep naming what that collection was called at the time and must
 * not follow a live constant that could be renamed underneath it.
 */
const LANE_COLLECTION = 'lanes';
const LANE_MUTE_COLLECTION = 'lanemutes';

export const migrationLaneIndexes: Migration = {
  id: MIGRATION_LANE_INDEXES,

  async run(db: mongoose.mongo.Db): Promise<void> {
    const lanes = db.collection(LANE_COLLECTION);
    await lanes.createIndex({ ownerType: 1, ownerId: 1, createdAt: -1 });
    await lanes.createIndex({ ownerType: 1, ownerId: 1, nameLower: 1 }, { unique: true });
    await lanes.createIndex({ ownerType: 1, ownerId: 1, displayMode: 1 });

    const mutes = db.collection(LANE_MUTE_COLLECTION);
    await mutes.createIndex({ viewerOxyUserId: 1, laneId: 1 }, { unique: true });
    await mutes.createIndex({ viewerOxyUserId: 1, createdAt: -1 });

    logger.info(
      `[migration] ensured indexes on ${lanes.collectionName} ` +
        '{ ownerType, ownerId, createdAt }, { ownerType, ownerId, nameLower } (unique), ' +
        `{ ownerType, ownerId, displayMode } and on ${mutes.collectionName} ` +
        '{ viewerOxyUserId, laneId } (unique), { viewerOxyUserId, createdAt }',
    );
  },
};
