/**
 * Migration 0005: index the starter-pack CURATION aggregation.
 *
 * The `starterPackBoost` ranking signal (`services/starterPackCuration.ts`) reads
 * curation edges with an aggregation whose first stage is
 * `$match: { memberOxyUserIds: { $in: [...authors] }, useCount: { $gte: n } }`.
 * That stage runs on EVERY user-summary cache-fill batch
 * (`PostHydrationService.resolveUserSummaries`), i.e. on cold feed hydration for
 * every viewer.
 *
 * `StarterPack.ts` declares the MULTIKEY compound index
 * `{ memberOxyUserIds: 1, useCount: -1 }` that serves exactly that match — but
 * `autoIndex`/`autoCreate` are OFF in production (see `utils/database.ts`), so a
 * schema-declared index NEVER reaches production. Without it, the aggregation
 * falls back to a COLLECTION SCAN of `starterpacks` on every cache-fill batch: a
 * silent, ever-growing performance regression that no test or type check catches.
 * This migration is therefore the only thing that creates the index in production.
 *
 * `memberOxyUserIds` is the only array field in the compound (a compound index may
 * have at most one), so the `$in` on the members is index-served and `useCount`
 * filters within it.
 *
 * Idempotent: an equivalent existing index is left untouched and re-running is a
 * no-op. Data-free — creating an index needs no backfill.
 */

import mongoose from 'mongoose';
import { logger } from '../utils/logger';
import { MIGRATION_STARTER_PACK_MEMBER_INDEX } from './constants';
import StarterPack from '../models/StarterPack';
import type { Migration } from './runner';

interface MongoIndexInfo {
  name: string;
  key: Record<string, unknown>;
}

/**
 * The index this migration guarantees. Written as an ordered field list because a
 * compound index's key ORDER is semantic: `{ useCount: -1, memberOxyUserIds: 1 }`
 * has the same fields but a range-scan prefix, so it does not serve the curation
 * `$match` and must NOT be mistaken for an equivalent index.
 */
const CURATION_INDEX_FIELDS: ReadonlyArray<readonly [field: string, direction: 1 | -1]> = [
  ['memberOxyUserIds', 1],
  ['useCount', -1],
];

/** True only for an index whose key is exactly {@link CURATION_INDEX_FIELDS}, in order. */
function isCurationIndex(index: MongoIndexInfo): boolean {
  const fields = Object.keys(index.key);
  if (fields.length !== CURATION_INDEX_FIELDS.length) {
    return false;
  }
  return CURATION_INDEX_FIELDS.every(
    ([field, direction], position) =>
      fields[position] === field && index.key[field] === direction,
  );
}

export const migrationStarterPackMemberIndex: Migration = {
  id: MIGRATION_STARTER_PACK_MEMBER_INDEX,

  async run(db: mongoose.mongo.Db): Promise<void> {
    const collection = db.collection(StarterPack.collection.collectionName);

    let indexes: MongoIndexInfo[];
    try {
      indexes = (await collection.indexes()) as MongoIndexInfo[];
    } catch (error) {
      // NamespaceNotFound means the collection does not exist yet — treat it as
      // having no indexes; createIndex below creates both it and the index.
      if (error instanceof mongoose.mongo.MongoServerError && error.codeName === 'NamespaceNotFound') {
        indexes = [];
      } else {
        throw error;
      }
    }

    const existing = indexes.find(isCurationIndex);

    if (existing) {
      logger.info(
        `[migration] starter-pack curation index already present (${existing.name}) — skipping`,
      );
      return;
    }

    await collection.createIndex({ memberOxyUserIds: 1, useCount: -1 });
    logger.info(
      `[migration] created curation index on ${collection.collectionName} { memberOxyUserIds: 1, useCount: -1 }`,
    );
  },
};
