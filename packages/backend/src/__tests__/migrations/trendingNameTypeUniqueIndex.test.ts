import { beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import { migrationTrendingNameTypeUniqueIndex } from '../../migrations/0013-trending-name-type-unique-index';

/**
 * Offline coverage for migration 0013 (Trending batch-uniqueness key).
 *
 * `autoIndex`/`autoCreate` are OFF in production, so this migration is the only
 * thing that widens `{ name, calculatedAt }` to `{ name, calculatedAt, type }`.
 * The Mongo `Db`/collection are faked (indexes/createIndex/dropIndex captured) so
 * the real branch logic runs without a database.
 *
 * The ordering assertion is the important one: the wider key must be CREATED
 * before the old one is dropped. The wider key is strictly weaker, so its build
 * can never fail on data the old index already permitted, and the collection is
 * never left without a uniqueness constraint. Dropping first would open a window
 * for a duplicate to land and permanently block the new index from building.
 */

interface FakeIndex {
  name: string;
  key: Record<string, unknown>;
  unique?: boolean;
  expireAfterSeconds?: number;
}

const OLD_INDEX: FakeIndex = {
  name: 'name_1_calculatedAt_1',
  key: { name: 1, calculatedAt: 1 },
  unique: true,
};
const NEW_INDEX: FakeIndex = {
  name: 'name_1_calculatedAt_1_type_1',
  key: { name: 1, calculatedAt: 1, type: 1 },
  unique: true,
};
const TTL_INDEX: FakeIndex = {
  name: 'calculatedAt_1',
  key: { calculatedAt: 1 },
  expireAfterSeconds: 90 * 24 * 60 * 60,
};
const COMPOUND_INDEX: FakeIndex = {
  name: 'calculatedAt_-1_score_-1',
  key: { calculatedAt: -1, score: -1 },
};

function makeDb(indexes: FakeIndex[], indexesThrows?: unknown) {
  const calls: string[] = [];
  const createIndex = vi.fn().mockImplementation(() => {
    calls.push('create');
    return Promise.resolve('name_1_calculatedAt_1_type_1');
  });
  const dropIndex = vi.fn().mockImplementation(() => {
    calls.push('drop');
    return Promise.resolve(undefined);
  });
  const indexesFn = indexesThrows
    ? vi.fn().mockRejectedValue(indexesThrows)
    : vi.fn().mockResolvedValue(indexes);
  const collection = { collectionName: 'trendings', indexes: indexesFn, dropIndex, createIndex };
  const db = { collection: vi.fn().mockReturnValue(collection) } as unknown as mongoose.mongo.Db;
  return { db, createIndex, dropIndex, calls };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('migration 0013 — trending { name, calculatedAt, type } unique index', () => {
  it('creates the widened unique index BEFORE dropping the superseded one', async () => {
    const { db, createIndex, dropIndex, calls } = makeDb([
      { name: '_id_', key: { _id: 1 } },
      OLD_INDEX,
    ]);

    await migrationTrendingNameTypeUniqueIndex.run(db);

    expect(createIndex).toHaveBeenCalledWith(
      { name: 1, calculatedAt: 1, type: 1 },
      { unique: true },
    );
    expect(dropIndex).toHaveBeenCalledWith('name_1_calculatedAt_1');
    expect(calls).toEqual(['create', 'drop']);
  });

  it('creates the widened index on a collection that has neither', async () => {
    const { db, createIndex, dropIndex } = makeDb([{ name: '_id_', key: { _id: 1 } }]);

    await migrationTrendingNameTypeUniqueIndex.run(db);

    expect(createIndex).toHaveBeenCalledOnce();
    expect(dropIndex).not.toHaveBeenCalled();
  });

  it('is a no-op when the widened index already exists and the old one is gone', async () => {
    const { db, createIndex, dropIndex } = makeDb([NEW_INDEX, TTL_INDEX, COMPOUND_INDEX]);

    await migrationTrendingNameTypeUniqueIndex.run(db);

    expect(createIndex).not.toHaveBeenCalled();
    expect(dropIndex).not.toHaveBeenCalled();
  });

  it('finishes the job when a previous run died between create and drop', async () => {
    // Both present: the widened index built, the process died before the drop.
    // Re-running must skip the build and complete the drop.
    const { db, createIndex, dropIndex } = makeDb([NEW_INDEX, OLD_INDEX]);

    await migrationTrendingNameTypeUniqueIndex.run(db);

    expect(createIndex).not.toHaveBeenCalled();
    expect(dropIndex).toHaveBeenCalledWith('name_1_calculatedAt_1');
  });

  it('leaves the TTL and { calculatedAt, score } indexes untouched', async () => {
    const { db, dropIndex } = makeDb([TTL_INDEX, COMPOUND_INDEX, OLD_INDEX]);

    await migrationTrendingNameTypeUniqueIndex.run(db);

    expect(dropIndex).toHaveBeenCalledOnce();
    expect(dropIndex).toHaveBeenCalledWith('name_1_calculatedAt_1');
  });

  it('does not mistake a { calculatedAt, name } index for the superseded one', async () => {
    // Index keys are ORDERED: a reversed key is a different index serving
    // different queries, and dropping it would be data loss by accident.
    const { db, dropIndex } = makeDb([
      { name: 'calculatedAt_1_name_1', key: { calculatedAt: 1, name: 1 }, unique: true },
    ]);

    await migrationTrendingNameTypeUniqueIndex.run(db);

    expect(dropIndex).not.toHaveBeenCalled();
  });

  it('tolerates the superseded index vanishing under a concurrent run', async () => {
    const { db, dropIndex } = makeDb([OLD_INDEX]);
    dropIndex.mockRejectedValueOnce(
      new mongoose.mongo.MongoServerError({ message: 'index not found', codeName: 'IndexNotFound' }),
    );

    await expect(migrationTrendingNameTypeUniqueIndex.run(db)).resolves.toBeUndefined();
  });

  it('propagates a drop failure that is not IndexNotFound', async () => {
    const { db, dropIndex } = makeDb([OLD_INDEX]);
    dropIndex.mockRejectedValueOnce(
      new mongoose.mongo.MongoServerError({ message: 'not authorized', codeName: 'Unauthorized' }),
    );

    await expect(migrationTrendingNameTypeUniqueIndex.run(db)).rejects.toThrow('not authorized');
  });

  it('creates the widened index when the collection does not exist yet', async () => {
    const nsErr = new mongoose.mongo.MongoServerError({
      message: 'ns not found',
      codeName: 'NamespaceNotFound',
    });
    const { db, createIndex, dropIndex } = makeDb([], nsErr);

    await migrationTrendingNameTypeUniqueIndex.run(db);

    expect(createIndex).toHaveBeenCalledWith(
      { name: 1, calculatedAt: 1, type: 1 },
      { unique: true },
    );
    expect(dropIndex).not.toHaveBeenCalled();
  });
});
