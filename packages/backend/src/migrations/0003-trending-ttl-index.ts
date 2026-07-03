/**
 * Migration 0003: convert the `Trending.calculatedAt` index into a TTL index.
 *
 * The trending calculation job inserts a full batch of `Trending` rows every 30
 * minutes and never deletes them at the storage layer, so the collection grows
 * without bound. An unbounded collection makes the history aggregation (a
 * day-grouping over every document) progressively slower.
 *
 * The Mongoose schema now declares a TTL index
 * `{ calculatedAt: 1 }` with `expireAfterSeconds = TRENDING_TTL_SECONDS`, but
 * `autoIndex`/`autoCreate` are OFF in production (see `utils/database.ts`), so
 * the schema declaration alone never reaches the database. This migration
 * creates it explicitly.
 *
 * A plain (non-TTL) `{ calculatedAt: 1 }` index already exists in production
 * (it was declared with an inline `index: true` on the field). MongoDB cannot
 * add `expireAfterSeconds` to an existing index via `createIndex` (same key,
 * different options -> conflict) and TTL cannot be toggled on in place, so the
 * old index is dropped first and the TTL index recreated.
 *
 * Idempotent: if the correct TTL index already exists it is left untouched;
 * re-running is a no-op. The migrations collection also records completion so
 * the runner skips it on subsequent boots.
 *
 * Operational note: the TTL monitor reaps rows older than the retention window
 * automatically once this index exists — existing over-age documents are
 * removed by the background TTL sweep within ~60s of the index being created;
 * no separate backfill delete is required.
 */

import mongoose from 'mongoose';
import { logger } from '../utils/logger';
import { MIGRATION_TRENDING_TTL_INDEX } from './constants';
import TrendingModel, { TRENDING_TTL_SECONDS } from '../models/Trending';
import type { Migration } from './runner';

interface MongoIndexInfo {
  name: string;
  key: Record<string, unknown>;
  expireAfterSeconds?: number;
}

export const migrationTrendingTtlIndex: Migration = {
  id: MIGRATION_TRENDING_TTL_INDEX,

  async run(db: mongoose.mongo.Db): Promise<void> {
    const collection = db.collection(TrendingModel.collection.collectionName);

    let indexes: MongoIndexInfo[];
    try {
      indexes = (await collection.indexes()) as MongoIndexInfo[];
    } catch (error) {
      // NamespaceNotFound means the collection has no indexes yet — createIndex
      // below will create both the collection and the index.
      if (error instanceof mongoose.mongo.MongoServerError && error.codeName === 'NamespaceNotFound') {
        indexes = [];
      } else {
        throw error;
      }
    }

    // Locate any single-field ascending index on calculatedAt (by KEY, not by
    // name — MongoDB forbids two indexes with the same key regardless of name).
    const existing = indexes.find(
      (idx) => Object.keys(idx.key).length === 1 && idx.key.calculatedAt === 1,
    );

    if (existing && existing.expireAfterSeconds === TRENDING_TTL_SECONDS) {
      logger.info(
        `[migration] trending calculatedAt TTL index already present (${existing.name}) — nothing to do`,
      );
      return;
    }

    if (existing) {
      // Present but not the correct TTL (plain index or a stale TTL value).
      try {
        await collection.dropIndex(existing.name);
        logger.info(`[migration] dropped non-TTL trending index ${existing.name}`);
      } catch (error) {
        // IndexNotFound means a concurrent run already dropped it — safe.
        if (!(error instanceof mongoose.mongo.MongoServerError && error.codeName === 'IndexNotFound')) {
          throw error;
        }
      }
    }

    await collection.createIndex({ calculatedAt: 1 }, { expireAfterSeconds: TRENDING_TTL_SECONDS });
    logger.info(
      `[migration] created TTL index on ${collection.collectionName}.calculatedAt (expireAfterSeconds=${TRENDING_TTL_SECONDS})`,
    );
  },
};
