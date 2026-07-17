import { beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import { migrationFederatedStarterPackSourceIndex } from '../../migrations/0006-federated-starter-pack-source-index';
import { migrationFeedGeneratorIndex } from '../../migrations/0007-feed-generator-index';

/**
 * Offline coverage for the Bluesky (atproto) profile-graph import indexes.
 * `autoIndex`/`autoCreate` are OFF in production, so these migrations are the only
 * thing that creates them: migration 0006 the sparse-unique `source.uri` dedup index
 * on `starterpacks` (without which re-sync would duplicate mirrored packs), and
 * migration 0007 the native `feedgenerators` indexes (without which re-sync would
 * duplicate mirrored feed generators). The Mongo `Db` / collections are faked
 * (createIndex captured) so the real branch logic runs without a database.
 */

function makeDb() {
  const starterPacksCreateIndex = vi.fn().mockResolvedValue('idx');
  const feedGeneratorsCreateIndex = vi.fn().mockResolvedValue('idx');
  const collections: Record<string, { collectionName: string; createIndex: ReturnType<typeof vi.fn> }> = {
    starterpacks: { collectionName: 'starterpacks', createIndex: starterPacksCreateIndex },
    feedgenerators: { collectionName: 'feedgenerators', createIndex: feedGeneratorsCreateIndex },
  };
  const db = {
    collection: vi.fn((name: string) => collections[name]),
  } as unknown as mongoose.mongo.Db;
  return { db, starterPacksCreateIndex, feedGeneratorsCreateIndex };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('migration 0006 — federated starter-pack source index', () => {
  it('creates the sparse-unique source.uri index on starterpacks', async () => {
    const { db, starterPacksCreateIndex } = makeDb();

    await migrationFederatedStarterPackSourceIndex.run(db);

    expect(starterPacksCreateIndex).toHaveBeenCalledWith({ 'source.uri': 1 }, { unique: true, sparse: true });
    expect(db.collection).toHaveBeenCalledWith('starterpacks');
  });

  it('does NOT touch the removed externalfeeds collection', async () => {
    const { db } = makeDb();

    await migrationFederatedStarterPackSourceIndex.run(db);

    expect(db.collection).not.toHaveBeenCalledWith('externalfeeds');
  });
});

describe('migration 0007 — feed-generator indexes', () => {
  it('creates the unique uri dedup index + the createdBy owner-lookup index', async () => {
    const { db, feedGeneratorsCreateIndex } = makeDb();

    await migrationFeedGeneratorIndex.run(db);

    expect(feedGeneratorsCreateIndex).toHaveBeenCalledWith({ uri: 1 }, { unique: true });
    expect(feedGeneratorsCreateIndex).toHaveBeenCalledWith({ createdBy: 1 });
  });

  it('resolves the collection from the model, not a hardcoded name', async () => {
    const { db } = makeDb();

    await migrationFeedGeneratorIndex.run(db);

    expect(db.collection).toHaveBeenCalledWith('feedgenerators');
  });
});
