import { beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import { migrationLaneIndexes } from '../../migrations/0022-lane-indexes';
import { migrationPostLaneIndex } from '../../migrations/0023-post-lane-index';

/**
 * Offline coverage for the two Lanes migrations.
 *
 * `autoIndex`/`autoCreate` are OFF in production, so these migrations are the
 * ONLY thing that creates the indexes their schemas declare. The Mongo `Db` is
 * faked (every `createIndex` call captured) so the real code runs with no
 * database.
 *
 * What is actually being guarded, in both files:
 *
 *  - the two UNIQUE constraints (`{ownerType, ownerId, nameLower}` and
 *    `{viewerOxyUserId, laneId}`) really carry `unique: true` — without it the
 *    create route's 409 never fires and muting stops being idempotent, and
 *    neither failure is visible from the outside; and
 *  - `post_lane_chrono_v1` is PARTIAL, not sparse. A compound sparse index covers
 *    every document carrying ANY of its keys, and every post has `visibility`, so
 *    `sparse` would index the whole collection and save nothing.
 */

interface CreateIndexCall {
  collection: string;
  key: Record<string, unknown>;
  options?: Record<string, unknown>;
}

function makeDb(): { db: mongoose.mongo.Db; calls: CreateIndexCall[] } {
  const calls: CreateIndexCall[] = [];
  const db = {
    collection: (collectionName: string) => ({
      collectionName,
      createIndex: (key: Record<string, unknown>, options?: Record<string, unknown>) => {
        calls.push({ collection: collectionName, key, options });
        return Promise.resolve('ok');
      },
    }),
  } as unknown as mongoose.mongo.Db;
  return { db, calls };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('migration 0022 — lane indexes', () => {
  it('creates all three lane indexes and both lane-mute indexes', async () => {
    const { db, calls } = makeDb();

    await migrationLaneIndexes.run(db);

    expect(calls.map((call) => ({ collection: call.collection, key: call.key }))).toEqual([
      { collection: 'lanes', key: { ownerType: 1, ownerId: 1, createdAt: -1 } },
      { collection: 'lanes', key: { ownerType: 1, ownerId: 1, nameLower: 1 } },
      { collection: 'lanes', key: { ownerType: 1, ownerId: 1, displayMode: 1 } },
      { collection: 'lanemutes', key: { viewerOxyUserId: 1, laneId: 1 } },
      { collection: 'lanemutes', key: { viewerOxyUserId: 1, createdAt: -1 } },
    ]);
  });

  it('makes the lane-name index UNIQUE — the create route\'s 409 IS this constraint', async () => {
    const { db, calls } = makeDb();

    await migrationLaneIndexes.run(db);

    const nameIndex = calls.find((call) => 'nameLower' in call.key);
    expect(nameIndex?.options).toEqual({ unique: true });
  });

  it('makes the mute index UNIQUE — this is what makes muting idempotent', async () => {
    const { db, calls } = makeDb();

    await migrationLaneIndexes.run(db);

    const muteIndex = calls.find(
      (call) => call.collection === 'lanemutes' && 'laneId' in call.key,
    );
    expect(muteIndex?.options).toEqual({ unique: true });
  });

  it('leaves the two list indexes unconstrained', async () => {
    const { db, calls } = makeDb();

    await migrationLaneIndexes.run(db);

    for (const call of calls.filter((c) => 'createdAt' in c.key)) {
      expect(call.options).toBeUndefined();
    }
  });
});

describe('migration 0023 — post lane index', () => {
  it('creates post_lane_chrono_v1 on the ChronoCursor keyset', async () => {
    const { db, calls } = makeDb();

    await migrationPostLaneIndex.run(db);

    expect(calls).toHaveLength(1);
    expect(calls[0].collection).toBe('posts');
    // `laneId` leads (the lane is reached directly), visibility+status narrow,
    // and `{createdAt, _id}` is the keyset `ChronoCursor` pages on — the same
    // axis `laneSource` sorts by.
    expect(calls[0].key).toEqual({
      laneId: 1,
      visibility: 1,
      status: 1,
      createdAt: -1,
      _id: -1,
    });
  });

  it('is PARTIAL, never sparse', async () => {
    const { db, calls } = makeDb();

    await migrationPostLaneIndex.run(db);

    expect(calls[0].options).toEqual({
      name: 'post_lane_chrono_v1',
      partialFilterExpression: { laneId: { $exists: true } },
    });
    // Stated as its own assertion because `sparse: true` is the plausible-looking
    // mistake: on a COMPOUND index Mongo covers a document carrying ANY indexed
    // key, and every post has `visibility` — so it would index the entire
    // collection while appearing to be an optimisation.
    expect(calls[0].options?.sparse).toBeUndefined();
  });
});
