import { beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import { migrationTrendingTtlIndex } from '../../migrations/0003-trending-ttl-index';
import { TRENDING_TTL_SECONDS } from '../../models/Trending';

/**
 * Offline coverage for migration 0003 (Trending TTL index).
 *
 * `autoIndex`/`autoCreate` are OFF in production, so this migration is the only
 * thing that creates the `{ calculatedAt: 1 }` TTL index. The Mongo `Db` /
 * collection are faked (indexes/createIndex/dropIndex captured) so the real
 * branch logic runs without a database:
 *   - no existing single-field calculatedAt index   -> create TTL, no drop
 *   - existing PLAIN calculatedAt index             -> drop it, then create TTL
 *   - existing TTL index already correct            -> no-op (idempotent)
 *   - collection missing (NamespaceNotFound)        -> create TTL
 */

interface FakeIndex {
  name: string;
  key: Record<string, unknown>;
  expireAfterSeconds?: number;
}

function makeDb(indexes: FakeIndex[], indexesThrows?: unknown) {
  const createIndex = vi.fn().mockResolvedValue('calculatedAt_1');
  const dropIndex = vi.fn().mockResolvedValue(undefined);
  const indexesFn = indexesThrows
    ? vi.fn().mockRejectedValue(indexesThrows)
    : vi.fn().mockResolvedValue(indexes);
  const collection = { collectionName: 'trendings', indexes: indexesFn, dropIndex, createIndex };
  const db = { collection: vi.fn().mockReturnValue(collection) } as unknown as mongoose.mongo.Db;
  return { db, createIndex, dropIndex };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('migration 0003 — trending TTL index', () => {
  it('creates the TTL index when no calculatedAt index exists', async () => {
    const { db, createIndex, dropIndex } = makeDb([{ name: '_id_', key: { _id: 1 } }]);

    await migrationTrendingTtlIndex.run(db);

    expect(dropIndex).not.toHaveBeenCalled();
    expect(createIndex).toHaveBeenCalledWith(
      { calculatedAt: 1 },
      { expireAfterSeconds: TRENDING_TTL_SECONDS },
    );
  });

  it('drops a plain calculatedAt index then recreates it as a TTL index', async () => {
    const { db, createIndex, dropIndex } = makeDb([
      { name: '_id_', key: { _id: 1 } },
      { name: 'calculatedAt_1', key: { calculatedAt: 1 } }, // no expireAfterSeconds
    ]);

    await migrationTrendingTtlIndex.run(db);

    expect(dropIndex).toHaveBeenCalledWith('calculatedAt_1');
    expect(createIndex).toHaveBeenCalledWith(
      { calculatedAt: 1 },
      { expireAfterSeconds: TRENDING_TTL_SECONDS },
    );
  });

  it('is a no-op when the correct TTL index already exists', async () => {
    const { db, createIndex, dropIndex } = makeDb([
      { name: 'calculatedAt_1', key: { calculatedAt: 1 }, expireAfterSeconds: TRENDING_TTL_SECONDS },
    ]);

    await migrationTrendingTtlIndex.run(db);

    expect(dropIndex).not.toHaveBeenCalled();
    expect(createIndex).not.toHaveBeenCalled();
  });

  it('leaves the compound { calculatedAt: -1, score: -1 } index untouched', async () => {
    const { db, dropIndex, createIndex } = makeDb([
      { name: 'calculatedAt_-1_score_-1', key: { calculatedAt: -1, score: -1 } },
    ]);

    await migrationTrendingTtlIndex.run(db);

    // Only the single-field ascending index is a conversion target; the compound
    // (2-field) index must never be dropped.
    expect(dropIndex).not.toHaveBeenCalled();
    expect(createIndex).toHaveBeenCalledOnce();
  });

  it('creates the TTL index when the collection does not exist yet', async () => {
    const nsErr = new mongoose.mongo.MongoServerError({
      message: 'ns not found',
      codeName: 'NamespaceNotFound',
    });
    const { db, createIndex } = makeDb([], nsErr);

    await migrationTrendingTtlIndex.run(db);

    expect(createIndex).toHaveBeenCalledWith(
      { calculatedAt: 1 },
      { expireAfterSeconds: TRENDING_TTL_SECONDS },
    );
  });
});
