/**
 * Migration 0006: indexes for the Bluesky (atproto) profile-graph import.
 *
 * Creates the indexes the schemas declare for mirrored starter packs + external
 * feed references. `autoIndex`/`autoCreate` are OFF in production (see
 * `utils/database.ts`), so a schema-declared index NEVER reaches production — this
 * migration is the only thing that creates them.
 *
 *  - `starterpacks` SPARSE UNIQUE `{ 'source.uri': 1 }` — the dedup key for every
 *    mirrored pack. WITHOUT it, re-syncing an actor's packs would DUPLICATE them on
 *    every profile view (the upsert would never find the prior row). SPARSE so it
 *    covers only packs that carry a `source`; the millions of native packs (no
 *    `source` field) are excluded, so their uniqueness is unaffected.
 *  - `externalfeeds` UNIQUE `{ uri: 1 }` — one row per remote feed generator (the
 *    upsert dedup key) — and `{ ownerOxyUserId: 1, createdAt: -1 }` for the
 *    "feeds created by this user" profile lookup.
 *
 * Idempotent: `createIndex` with an identical spec is a no-op, and it creates the
 * `externalfeeds` collection on first run. Data-free — no backfill needed (there is
 * no pre-existing mirrored data, so the unique constraints cannot conflict).
 */

import mongoose from 'mongoose';
import { logger } from '../utils/logger';
import { MIGRATION_FEDERATED_STARTER_PACK_SOURCE_INDEX } from './constants';
import StarterPack from '../models/StarterPack';
import ExternalFeed from '../models/ExternalFeed';
import type { Migration } from './runner';

export const migrationFederatedStarterPackSourceIndex: Migration = {
  id: MIGRATION_FEDERATED_STARTER_PACK_SOURCE_INDEX,

  async run(db: mongoose.mongo.Db): Promise<void> {
    const starterPacks = db.collection(StarterPack.collection.collectionName);
    await starterPacks.createIndex({ 'source.uri': 1 }, { unique: true, sparse: true });
    logger.info(
      `[migration] ensured sparse-unique index on ${starterPacks.collectionName} { 'source.uri': 1 }`,
    );

    const externalFeeds = db.collection(ExternalFeed.collection.collectionName);
    await externalFeeds.createIndex({ uri: 1 }, { unique: true });
    await externalFeeds.createIndex({ ownerOxyUserId: 1, createdAt: -1 });
    logger.info(
      `[migration] ensured indexes on ${externalFeeds.collectionName} ` +
        `{ uri: 1 } (unique) + { ownerOxyUserId: 1, createdAt: -1 }`,
    );
  },
};
