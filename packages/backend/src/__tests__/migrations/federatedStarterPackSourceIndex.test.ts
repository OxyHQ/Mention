import { beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import { migrationFederatedStarterPackSourceIndex } from '../../migrations/0006-federated-starter-pack-source-index';

/**
 * Offline coverage for migration 0006 (federated starter-pack + external-feed
 * indexes). `autoIndex`/`autoCreate` are OFF in production, so this migration is
 * the only thing that creates the sparse-unique `source.uri` dedup index (without
 * which re-sync would duplicate mirrored packs) and the `externalfeeds` indexes.
 * The Mongo `Db` / collections are faked (createIndex captured) so the real branch
 * logic runs without a database.
 */

function makeDb() {
  const starterPacksCreateIndex = vi.fn().mockResolvedValue('idx');
  const externalFeedsCreateIndex = vi.fn().mockResolvedValue('idx');
  const collections: Record<string, { collectionName: string; createIndex: ReturnType<typeof vi.fn> }> = {
    starterpacks: { collectionName: 'starterpacks', createIndex: starterPacksCreateIndex },
    externalfeeds: { collectionName: 'externalfeeds', createIndex: externalFeedsCreateIndex },
  };
  const db = {
    collection: vi.fn((name: string) => collections[name]),
  } as unknown as mongoose.mongo.Db;
  return { db, starterPacksCreateIndex, externalFeedsCreateIndex };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('migration 0006 — federated starter-pack + external-feed indexes', () => {
  it('creates the sparse-unique source.uri index on starterpacks', async () => {
    const { db, starterPacksCreateIndex } = makeDb();

    await migrationFederatedStarterPackSourceIndex.run(db);

    expect(starterPacksCreateIndex).toHaveBeenCalledWith({ 'source.uri': 1 }, { unique: true, sparse: true });
  });

  it('creates the unique uri + owner-lookup indexes on externalfeeds', async () => {
    const { db, externalFeedsCreateIndex } = makeDb();

    await migrationFederatedStarterPackSourceIndex.run(db);

    expect(externalFeedsCreateIndex).toHaveBeenCalledWith({ uri: 1 }, { unique: true });
    expect(externalFeedsCreateIndex).toHaveBeenCalledWith({ ownerOxyUserId: 1, createdAt: -1 });
  });

  it('resolves the collections from the models, not hardcoded names', async () => {
    const { db } = makeDb();

    await migrationFederatedStarterPackSourceIndex.run(db);

    expect(db.collection).toHaveBeenCalledWith('starterpacks');
    expect(db.collection).toHaveBeenCalledWith('externalfeeds');
  });
});
