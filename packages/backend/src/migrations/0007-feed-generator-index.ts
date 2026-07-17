/**
 * Migration 0007: indexes for the native `FeedGenerator` collection.
 *
 * A Bluesky feed generator is mirrored into a native `FeedGenerator` (keyed on its
 * AT-URI) and served by the feed engine via the `feedgen|<uri>` descriptor. The
 * schema declares `uri` (unique) + `createdBy` indexes, but `autoIndex`/`autoCreate`
 * are OFF in production (see `utils/database.ts`), so this migration is the only
 * thing that creates them.
 *
 *  - `feedgenerators` UNIQUE `{ uri: 1 }` — the dedup key for every mirrored
 *    generator. WITHOUT it, re-syncing an actor's feeds would DUPLICATE them on
 *    every profile view (the upsert on `uri` would never find the prior row) and the
 *    concurrent-import race (E11000) would be unguarded.
 *  - `feedgenerators` `{ createdBy: 1 }` — serves the per-owner "feeds created by
 *    this user" listing (the profile Feeds surface) without a collection scan.
 *
 * Idempotent: `createIndex` with an identical spec is a no-op, and it creates the
 * `feedgenerators` collection on first run. Data-free — no backfill needed (mirrored
 * generators are upserted on `uri`, so the unique constraint cannot conflict).
 */

import mongoose from 'mongoose';
import { logger } from '../utils/logger';
import { MIGRATION_FEED_GENERATOR_INDEX } from './constants';
import { FeedGenerator } from '../models/FeedGenerator';
import type { Migration } from './runner';

export const migrationFeedGeneratorIndex: Migration = {
  id: MIGRATION_FEED_GENERATOR_INDEX,

  async run(db: mongoose.mongo.Db): Promise<void> {
    const feedGenerators = db.collection(FeedGenerator.collection.collectionName);
    await feedGenerators.createIndex({ uri: 1 }, { unique: true });
    await feedGenerators.createIndex({ createdBy: 1 });
    logger.info(
      `[migration] ensured indexes on ${feedGenerators.collectionName} ` +
        `{ uri: 1 } (unique) + { createdBy: 1 }`,
    );
  },
};
