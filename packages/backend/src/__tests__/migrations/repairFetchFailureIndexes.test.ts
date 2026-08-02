import { beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import { migrationRepairFetchFailureIndexes } from '../../migrations/0017-repair-fetch-failure-indexes';

/**
 * Offline coverage for migration 0017 (re-fetch failure log indexes).
 *
 * `autoIndex`/`autoCreate` are OFF in production, so this migration is the only
 * thing that creates them. Both matter and for different reasons: without the
 * UNIQUE identity the log grows a row per failure instead of per failing post,
 * and without `{script, reason}` the one query the collection exists to serve —
 * "every post this sweep failed for a retryable reason" — is a collection scan,
 * which undermines the cheap targeted retry it was built to enable.
 */
function makeDb() {
  const createIndex = vi.fn().mockResolvedValue('idx');
  const collection = { collectionName: 'repairfetchfailures', createIndex };
  const db = { collection: vi.fn().mockReturnValue(collection) } as unknown as mongoose.mongo.Db;
  return { db, createIndex };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('migration 0017 — repair fetch failure indexes', () => {
  it('targets the collection resolved from the model, not a hardcoded name', async () => {
    const { db } = makeDb();

    await migrationRepairFetchFailureIndexes.run(db);

    expect(db.collection).toHaveBeenCalledWith('repairfetchfailures');
  });

  it('creates the UNIQUE { script, postId } identity that bounds the log', async () => {
    const { db, createIndex } = makeDb();

    await migrationRepairFetchFailureIndexes.run(db);

    expect(createIndex).toHaveBeenCalledWith({ script: 1, postId: 1 }, { unique: true });
  });

  it('creates the { script, reason } index the targeted retry reads', async () => {
    const { db, createIndex } = makeDb();

    await migrationRepairFetchFailureIndexes.run(db);

    expect(createIndex).toHaveBeenCalledWith({ script: 1, reason: 1 });
    expect(createIndex).toHaveBeenCalledTimes(2);
  });
});
