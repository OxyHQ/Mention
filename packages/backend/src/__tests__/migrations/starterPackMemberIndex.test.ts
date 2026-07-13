import { beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import { migrationStarterPackMemberIndex } from '../../migrations/0005-starter-pack-member-index';

/**
 * Offline coverage for migration 0005 (starter-pack curation index).
 *
 * `autoIndex`/`autoCreate` are OFF in production, so this migration is the only
 * thing that creates the multikey `{ memberOxyUserIds: 1, useCount: -1 }` index
 * that serves the curation aggregation. The Mongo `Db` / collection are faked
 * (indexes/createIndex captured) so the real branch logic runs without a database.
 */

interface FakeIndex {
  name: string;
  key: Record<string, unknown>;
}

function makeDb(indexes: FakeIndex[], indexesThrows?: unknown) {
  const createIndex = vi.fn().mockResolvedValue('idx');
  const indexesFn = indexesThrows
    ? vi.fn().mockRejectedValue(indexesThrows)
    : vi.fn().mockResolvedValue(indexes);
  const collection = { collectionName: 'starterpacks', indexes: indexesFn, createIndex };
  const db = { collection: vi.fn().mockReturnValue(collection) } as unknown as mongoose.mongo.Db;
  return { db, collection, createIndex };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('migration 0005 — starter-pack curation index', () => {
  it('targets the collection resolved from the model, not a hardcoded name', async () => {
    const { db } = makeDb([{ name: '_id_', key: { _id: 1 } }]);

    await migrationStarterPackMemberIndex.run(db);

    expect(db.collection).toHaveBeenCalledWith('starterpacks');
  });

  it('creates the curation index when it does not exist', async () => {
    const { db, createIndex } = makeDb([
      { name: '_id_', key: { _id: 1 } },
      { name: 'ownerOxyUserId_1_createdAt_-1', key: { ownerOxyUserId: 1, createdAt: -1 } },
      { name: 'useCount_-1_createdAt_-1', key: { useCount: -1, createdAt: -1 } },
    ]);

    await migrationStarterPackMemberIndex.run(db);

    expect(createIndex).toHaveBeenCalledWith({ memberOxyUserIds: 1, useCount: -1 });
    expect(createIndex).toHaveBeenCalledTimes(1);
  });

  it('is a no-op when the curation index already exists', async () => {
    const { db, createIndex } = makeDb([
      { name: '_id_', key: { _id: 1 } },
      { name: 'memberOxyUserIds_1_useCount_-1', key: { memberOxyUserIds: 1, useCount: -1 } },
    ]);

    await migrationStarterPackMemberIndex.run(db);

    expect(createIndex).not.toHaveBeenCalled();
  });

  it('creates the index when the collection does not exist yet', async () => {
    const nsErr = new mongoose.mongo.MongoServerError({
      message: 'ns not found',
      codeName: 'NamespaceNotFound',
    });
    const { db, createIndex } = makeDb([], nsErr);

    await migrationStarterPackMemberIndex.run(db);

    expect(createIndex).toHaveBeenCalledWith({ memberOxyUserIds: 1, useCount: -1 });
  });

  it('rethrows non-NamespaceNotFound errors from indexes()', async () => {
    const { db, createIndex } = makeDb([], new Error('connection reset'));

    await expect(migrationStarterPackMemberIndex.run(db)).rejects.toThrow('connection reset');
    expect(createIndex).not.toHaveBeenCalled();
  });

  it('does not treat a member-only or differently-ordered index as equivalent', async () => {
    const { db, createIndex } = makeDb([
      { name: 'memberOxyUserIds_1', key: { memberOxyUserIds: 1 } },
      { name: 'memberOxyUserIds_1_useCount_1', key: { memberOxyUserIds: 1, useCount: 1 } },
      { name: 'useCount_-1_memberOxyUserIds_1', key: { useCount: -1, memberOxyUserIds: 1 } },
    ]);

    await migrationStarterPackMemberIndex.run(db);

    // None of the above serve `{ $in: members }` + `useCount` in that key order,
    // so the real index must still be created.
    expect(createIndex).toHaveBeenCalledWith({ memberOxyUserIds: 1, useCount: -1 });
  });
});
