/**
 * Migration 0004: bound the `notifications` collection.
 *
 * Notifications are append-only — every like/reply/follow/mention inserts a row
 * and nothing ever deletes them — so the collection (and every recipient scan)
 * grows without bound. This migration creates two indexes the Mongoose schema
 * declares but that never reach production because `autoIndex`/`autoCreate` are
 * OFF there (see `utils/database.ts`):
 *
 *   1. a TTL index `{ createdAt: 1 }` (`expireAfterSeconds =
 *      NOTIFICATION_TTL_SECONDS`) so MongoDB's background monitor reaps rows
 *      older than the retention window — existing over-age rows are removed by
 *      the TTL sweep within ~60s of the index being created; no backfill needed;
 *   2. a keyset-pagination index `{ recipientId: 1, _id: -1 }` so the list query
 *      (`find({ recipientId, _id: { $lt } }).sort({ _id: -1 })`) is fully
 *      index-served.
 *
 * Idempotent: existing correct indexes are left untouched; re-running is a no-op.
 * If a PLAIN (non-TTL) `{ createdAt: 1 }` index somehow already exists it is
 * dropped first (TTL cannot be toggled on in place), mirroring migration 0003.
 */

import mongoose from 'mongoose';
import { logger } from '../utils/logger';
import { MIGRATION_NOTIFICATION_TTL_INDEX } from './constants';
import NotificationModel, { NOTIFICATION_TTL_SECONDS } from '../models/Notification';
import type { Migration } from './runner';

interface MongoIndexInfo {
  name: string;
  key: Record<string, unknown>;
  expireAfterSeconds?: number;
}

export const migrationNotificationTtlIndex: Migration = {
  id: MIGRATION_NOTIFICATION_TTL_INDEX,

  async run(db: mongoose.mongo.Db): Promise<void> {
    const collection = db.collection(NotificationModel.collection.collectionName);

    let indexes: MongoIndexInfo[];
    try {
      indexes = (await collection.indexes()) as MongoIndexInfo[];
    } catch (error) {
      // NamespaceNotFound means the collection has no indexes yet — createIndex
      // below will create both the collection and the indexes.
      if (error instanceof mongoose.mongo.MongoServerError && error.codeName === 'NamespaceNotFound') {
        indexes = [];
      } else {
        throw error;
      }
    }

    // --- 1. TTL index on createdAt ---------------------------------------
    const existingCreatedAt = indexes.find(
      (idx) => Object.keys(idx.key).length === 1 && idx.key.createdAt === 1,
    );

    if (existingCreatedAt && existingCreatedAt.expireAfterSeconds === NOTIFICATION_TTL_SECONDS) {
      logger.info(
        `[migration] notification createdAt TTL index already present (${existingCreatedAt.name}) — skipping`,
      );
    } else {
      if (existingCreatedAt) {
        // Present but not the correct TTL (plain index or a stale TTL value).
        try {
          await collection.dropIndex(existingCreatedAt.name);
          logger.info(`[migration] dropped non-TTL notification index ${existingCreatedAt.name}`);
        } catch (error) {
          // IndexNotFound means a concurrent run already dropped it — safe.
          if (!(error instanceof mongoose.mongo.MongoServerError && error.codeName === 'IndexNotFound')) {
            throw error;
          }
        }
      }
      await collection.createIndex({ createdAt: 1 }, { expireAfterSeconds: NOTIFICATION_TTL_SECONDS });
      logger.info(
        `[migration] created TTL index on ${collection.collectionName}.createdAt (expireAfterSeconds=${NOTIFICATION_TTL_SECONDS})`,
      );
    }

    // --- 2. Keyset-pagination index { recipientId: 1, _id: -1 } -----------
    const existingKeyset = indexes.find(
      (idx) =>
        Object.keys(idx.key).length === 2 &&
        idx.key.recipientId === 1 &&
        idx.key._id === -1,
    );

    if (existingKeyset) {
      logger.info(
        `[migration] notification keyset index already present (${existingKeyset.name}) — skipping`,
      );
    } else {
      await collection.createIndex({ recipientId: 1, _id: -1 });
      logger.info(
        `[migration] created keyset index on ${collection.collectionName} { recipientId: 1, _id: -1 }`,
      );
    }
  },
};
