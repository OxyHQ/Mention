import { beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import { migrationNotificationTtlIndex } from '../../migrations/0004-notification-ttl-index';
import { NOTIFICATION_TTL_SECONDS } from '../../models/Notification';

/**
 * Offline coverage for migration 0004 (Notification bounding indexes).
 *
 * `autoIndex`/`autoCreate` are OFF in production, so this migration is the only
 * thing that creates the `{ createdAt: 1 }` TTL index and the
 * `{ recipientId: 1, _id: -1 }` keyset index. The Mongo `Db` / collection are
 * faked (indexes/createIndex/dropIndex captured) so the real branch logic runs
 * without a database.
 */

interface FakeIndex {
  name: string;
  key: Record<string, unknown>;
  expireAfterSeconds?: number;
}

function makeDb(indexes: FakeIndex[], indexesThrows?: unknown) {
  const createIndex = vi.fn().mockResolvedValue('idx');
  const dropIndex = vi.fn().mockResolvedValue(undefined);
  const indexesFn = indexesThrows
    ? vi.fn().mockRejectedValue(indexesThrows)
    : vi.fn().mockResolvedValue(indexes);
  const collection = { collectionName: 'notifications', indexes: indexesFn, dropIndex, createIndex };
  const db = { collection: vi.fn().mockReturnValue(collection) } as unknown as mongoose.mongo.Db;
  return { db, createIndex, dropIndex };
}

/** Read every key object passed to createIndex, in call order. */
function createdKeys(createIndex: ReturnType<typeof vi.fn>): Record<string, unknown>[] {
  return createIndex.mock.calls.map((c) => c[0] as Record<string, unknown>);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('migration 0004 — notification bounding indexes', () => {
  it('creates BOTH the TTL and keyset indexes when neither exists', async () => {
    const { db, createIndex, dropIndex } = makeDb([{ name: '_id_', key: { _id: 1 } }]);

    await migrationNotificationTtlIndex.run(db);

    expect(dropIndex).not.toHaveBeenCalled();
    expect(createIndex).toHaveBeenCalledWith(
      { createdAt: 1 },
      { expireAfterSeconds: NOTIFICATION_TTL_SECONDS },
    );
    expect(createIndex).toHaveBeenCalledWith({ recipientId: 1, _id: -1 });
    expect(createIndex).toHaveBeenCalledTimes(2);
  });

  it('is a no-op when both indexes already exist correctly', async () => {
    const { db, createIndex, dropIndex } = makeDb([
      { name: 'createdAt_1', key: { createdAt: 1 }, expireAfterSeconds: NOTIFICATION_TTL_SECONDS },
      { name: 'recipientId_1__id_-1', key: { recipientId: 1, _id: -1 } },
    ]);

    await migrationNotificationTtlIndex.run(db);

    expect(dropIndex).not.toHaveBeenCalled();
    expect(createIndex).not.toHaveBeenCalled();
  });

  it('drops a plain createdAt index then recreates it as a TTL index', async () => {
    const { db, createIndex, dropIndex } = makeDb([
      { name: 'createdAt_1', key: { createdAt: 1 } }, // no expireAfterSeconds
      { name: 'recipientId_1__id_-1', key: { recipientId: 1, _id: -1 } },
    ]);

    await migrationNotificationTtlIndex.run(db);

    expect(dropIndex).toHaveBeenCalledWith('createdAt_1');
    expect(createIndex).toHaveBeenCalledWith(
      { createdAt: 1 },
      { expireAfterSeconds: NOTIFICATION_TTL_SECONDS },
    );
    // Keyset already present — only the TTL index is (re)created.
    expect(createdKeys(createIndex)).toEqual([{ createdAt: 1 }]);
  });

  it('creates only the missing keyset index when the TTL index is already correct', async () => {
    const { db, createIndex, dropIndex } = makeDb([
      { name: 'createdAt_1', key: { createdAt: 1 }, expireAfterSeconds: NOTIFICATION_TTL_SECONDS },
    ]);

    await migrationNotificationTtlIndex.run(db);

    expect(dropIndex).not.toHaveBeenCalled();
    expect(createdKeys(createIndex)).toEqual([{ recipientId: 1, _id: -1 }]);
  });

  it('leaves the existing { recipientId: 1, createdAt: -1 } index untouched', async () => {
    const { db, dropIndex } = makeDb([
      { name: 'recipientId_1_createdAt_-1', key: { recipientId: 1, createdAt: -1 } },
    ]);

    await migrationNotificationTtlIndex.run(db);

    // The createdAt-DESCENDING compound index is neither the TTL target nor the
    // keyset target, so it must never be dropped.
    expect(dropIndex).not.toHaveBeenCalled();
  });

  it('creates both indexes when the collection does not exist yet', async () => {
    const nsErr = new mongoose.mongo.MongoServerError({
      message: 'ns not found',
      codeName: 'NamespaceNotFound',
    });
    const { db, createIndex } = makeDb([], nsErr);

    await migrationNotificationTtlIndex.run(db);

    expect(createIndex).toHaveBeenCalledWith(
      { createdAt: 1 },
      { expireAfterSeconds: NOTIFICATION_TTL_SECONDS },
    );
    expect(createIndex).toHaveBeenCalledWith({ recipientId: 1, _id: -1 });
  });
});
