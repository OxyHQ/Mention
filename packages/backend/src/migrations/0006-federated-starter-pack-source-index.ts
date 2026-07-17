/**
 * Migration 0006: the SPARSE UNIQUE `{ 'source.uri': 1 }` dedup index on
 * `starterpacks` for the Bluesky (atproto) profile-graph import.
 *
 * `autoIndex`/`autoCreate` are OFF in production (see `utils/database.ts`), so a
 * schema-declared index NEVER reaches production — this migration is the only thing
 * that creates it.
 *
 *  - `starterpacks` SPARSE UNIQUE `{ 'source.uri': 1 }` — the dedup key for every
 *    mirrored pack. WITHOUT it, re-syncing an actor's packs would DUPLICATE them on
 *    every profile view (the upsert would never find the prior row). SPARSE so it
 *    covers only packs that carry a `source`; the millions of native packs (no
 *    `source` field) are excluded, so their uniqueness is unaffected.
 *
 * The mirrored FEED-GENERATOR indexes live in migration
 * `0007-feed-generator-index` (feeds are mirrored into the native `FeedGenerator`
 * collection, not a separate reference collection).
 *
 * Idempotent: `createIndex` with an identical spec is a no-op. Data-free — no
 * backfill needed (there is no pre-existing mirrored data, so the unique constraint
 * cannot conflict).
 */

import mongoose from 'mongoose';
import { logger } from '../utils/logger';
import { MIGRATION_FEDERATED_STARTER_PACK_SOURCE_INDEX } from './constants';
import StarterPack from '../models/StarterPack';
import type { Migration } from './runner';

export const migrationFederatedStarterPackSourceIndex: Migration = {
  id: MIGRATION_FEDERATED_STARTER_PACK_SOURCE_INDEX,

  async run(db: mongoose.mongo.Db): Promise<void> {
    const starterPacks = db.collection(StarterPack.collection.collectionName);
    await starterPacks.createIndex({ 'source.uri': 1 }, { unique: true, sparse: true });
    logger.info(
      `[migration] ensured sparse-unique index on ${starterPacks.collectionName} { 'source.uri': 1 }`,
    );
  },
};
