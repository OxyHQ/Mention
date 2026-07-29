/**
 * Migration 0013: widen the `Trending` batch uniqueness key to include `type`.
 *
 * The old index was `{ name: 1, calculatedAt: 1 }` unique, which encodes "a name
 * trends at most once per batch". That is wrong: a hashtag someone typed and a
 * topic the classifier inferred are different trends that happen to share a name.
 * When one batch contained both (observed in production for `business`), the
 * ordered `insertMany` aborted on the duplicate, the batch landed partial, and
 * `TrendBatch.create` — which runs after it — never executed. `GET /trending`
 * derives its timestamp from `TrendBatch`, so it served one frozen batch for over
 * a day while returning HTTP 200 and looking healthy.
 *
 * Ordering matters and is deliberate: CREATE the wider index FIRST, then drop the
 * old one. The wider key is strictly weaker — every document set that satisfies
 * `{name, calculatedAt}` uniqueness also satisfies `{name, calculatedAt, type}`
 * uniqueness — so the build can never fail on existing data, and at no instant is
 * the collection left without a uniqueness constraint. Dropping first would open a
 * window in which a duplicate could land and then permanently block the new index
 * from building.
 *
 * `type` is the LAST key so `{ name, calculatedAt }` remains an exact prefix; the
 * per-name volume-series scan behind the trend sparkline sorts on exactly that and
 * keeps getting its ordering from the index rather than a blocking SORT stage.
 *
 * Idempotent: an already-correct index is left alone and a missing old index is
 * not an error, so a retry after a crash between the two steps completes cleanly.
 *
 * Rolling-deploy safe in both directions. The change is index-only and imposes no
 * requirement on application code: tasks running the OLD image write batches that
 * simply stop colliding, and tasks running the NEW image work identically against
 * the old index right up until it is dropped. A rollback needs no counter-migration.
 */

import mongoose from 'mongoose';
import { logger } from '../utils/logger';
import { MIGRATION_TRENDING_NAME_TYPE_UNIQUE_INDEX } from './constants';
import TrendingModel from '../models/Trending';
import type { Migration } from './runner';

interface MongoIndexInfo {
  name: string;
  key: Record<string, unknown>;
  unique?: boolean;
}

/** The superseded key: uniqueness over the name alone within a batch. */
const OLD_KEY = { name: 1, calculatedAt: 1 } as const;
/** The current key: a trend is a (name, type) pair within a batch. */
const NEW_KEY = { name: 1, calculatedAt: 1, type: 1 } as const;

/** Index keys are ordered, so compare the entry sequence, not just membership. */
function hasKey(index: MongoIndexInfo, key: Record<string, number>): boolean {
  const actual = Object.entries(index.key);
  const expected = Object.entries(key);
  return (
    actual.length === expected.length &&
    actual.every(
      ([field, direction], position) =>
        field === expected[position][0] && direction === expected[position][1],
    )
  );
}

export const migrationTrendingNameTypeUniqueIndex: Migration = {
  id: MIGRATION_TRENDING_NAME_TYPE_UNIQUE_INDEX,

  async run(db: mongoose.mongo.Db): Promise<void> {
    const collection = db.collection(TrendingModel.collection.collectionName);

    let indexes: MongoIndexInfo[];
    try {
      indexes = (await collection.indexes()) as MongoIndexInfo[];
    } catch (error) {
      // NamespaceNotFound means the collection has no indexes yet — createIndex
      // below creates both the collection and the index.
      if (error instanceof mongoose.mongo.MongoServerError && error.codeName === 'NamespaceNotFound') {
        indexes = [];
      } else {
        throw error;
      }
    }

    if (!indexes.some((index) => hasKey(index, NEW_KEY) && index.unique === true)) {
      await collection.createIndex(NEW_KEY, { unique: true });
      logger.info(
        `[migration] created unique index on ${collection.collectionName} { name, calculatedAt, type }`,
      );
    }

    const superseded = indexes.find((index) => hasKey(index, OLD_KEY));
    if (!superseded) return;

    try {
      await collection.dropIndex(superseded.name);
      logger.info(`[migration] dropped superseded trending index ${superseded.name}`);
    } catch (error) {
      // IndexNotFound means a concurrent or earlier run already dropped it.
      if (!(error instanceof mongoose.mongo.MongoServerError && error.codeName === 'IndexNotFound')) {
        throw error;
      }
    }
  },
};
