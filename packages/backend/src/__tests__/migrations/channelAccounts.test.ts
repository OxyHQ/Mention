import { beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import { migrationChannelAccounts } from '../../migrations/0026-channel-accounts';

/**
 * Offline coverage for migration 0026 — retiring the Mention-local channel.
 *
 * The Mongo `Db` is faked (every call captured) so the real code runs with no
 * database. What is actually being guarded:
 *
 *  - the ORDER of the two lane-index operations. The new UNIQUE
 *    `{ownerId, nameLower}` is created BEFORE the old `{ownerType, ownerId,
 *    nameLower}` is dropped, so there is no window in which two concurrent
 *    creates of the same lane name are unconstrained. Dropping first would be
 *    invisible in production until it wasn't;
 *  - IDEMPOTENCE. `dropIndex` on a missing index raises `IndexNotFound`, and a
 *    migration that throws on its second run blocks every later migration on any
 *    database where this one already succeeded;
 *  - that legacy channel posts make the migration fail closed before any data or
 *    indexes are changed. Removing their only marker would expose their human
 *    writer on profile and follower feeds.
 */

interface Call {
  op: string;
  collection?: string;
  arg?: unknown;
  options?: unknown;
}

function makeDb(
  options: {
    existingIndexes?: string[];
    existingCollections?: string[];
    legacyChannelPost?: { _id: string; channelId: string };
  } = {},
) {
  const existingIndexes = new Set(
    options.existingIndexes ?? [
      'ownerType_1_ownerId_1_createdAt_-1',
      'ownerType_1_ownerId_1_nameLower_1',
      'ownerType_1_ownerId_1_displayMode_1',
      'post_channel_chrono_v1',
    ],
  );
  const existingCollections = new Set(
    options.existingCollections ?? ['channels', 'channelmembers', 'channelfollows'],
  );
  const calls: Call[] = [];

  const db = {
    collection: (collectionName: string) => ({
      collectionName,
      findOne: (filter: Record<string, unknown>, findOptions?: Record<string, unknown>) => {
        calls.push({ op: 'findOne', collection: collectionName, arg: filter, options: findOptions });
        return Promise.resolve(
          collectionName === 'posts' ? (options.legacyChannelPost ?? null) : null,
        );
      },
      createIndex: (key: Record<string, unknown>, opts?: Record<string, unknown>) => {
        calls.push({ op: 'createIndex', collection: collectionName, arg: key, options: opts });
        return Promise.resolve('ok');
      },
      indexExists: (name: string) => Promise.resolve(existingIndexes.has(name)),
      dropIndex: (name: string) => {
        calls.push({ op: 'dropIndex', collection: collectionName, arg: name });
        existingIndexes.delete(name);
        return Promise.resolve();
      },
      updateMany: (filter: Record<string, unknown>, update: Record<string, unknown>) => {
        calls.push({ op: 'updateMany', collection: collectionName, arg: filter, options: update });
        return Promise.resolve({ modifiedCount: 3 });
      },
    }),
    listCollections: (filter: { name: string }) => ({
      toArray: () =>
        Promise.resolve(existingCollections.has(filter.name) ? [{ name: filter.name }] : []),
    }),
    dropCollection: (name: string) => {
      calls.push({ op: 'dropCollection', arg: name });
      existingCollections.delete(name);
      return Promise.resolve(true);
    },
  } as unknown as mongoose.mongo.Db;

  return { db, calls };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('migration 0026 — channel accounts', () => {
  it('re-keys the three lane indexes onto ownerId alone', async () => {
    const { db, calls } = makeDb();

    await migrationChannelAccounts.run(db);

    const created = calls.filter((call) => call.op === 'createIndex');
    expect(created.map((call) => call.arg)).toEqual([
      { ownerId: 1, createdAt: -1 },
      { ownerId: 1, nameLower: 1 },
      { ownerId: 1, displayMode: 1 },
    ]);
  });

  it('keeps the lane-name index UNIQUE — the create route\'s 409 IS this constraint', async () => {
    const { db, calls } = makeDb();

    await migrationChannelAccounts.run(db);

    const nameIndex = calls.find(
      (call) => call.op === 'createIndex' && 'nameLower' in (call.arg as object),
    );
    expect(nameIndex?.options).toEqual({ unique: true });
  });

  it('CREATES the new unique index before DROPPING the old one', async () => {
    // Reversed, two concurrent creates of the same lane name are unconstrained for
    // the duration of the migration — and nothing would report it.
    const { db, calls } = makeDb();

    await migrationChannelAccounts.run(db);

    const createdUnique = calls.findIndex(
      (call) => call.op === 'createIndex' && 'nameLower' in (call.arg as object),
    );
    const droppedUnique = calls.findIndex(
      (call) => call.op === 'dropIndex' && call.arg === 'ownerType_1_ownerId_1_nameLower_1',
    );
    expect(createdUnique).toBeGreaterThanOrEqual(0);
    expect(droppedUnique).toBeGreaterThanOrEqual(0);
    expect(createdUnique).toBeLessThan(droppedUnique);
  });

  it('drops the legacy lane indexes and the post channel index', async () => {
    const { db, calls } = makeDb();

    await migrationChannelAccounts.run(db);

    expect(calls.filter((call) => call.op === 'dropIndex').map((call) => call.arg)).toEqual([
      'ownerType_1_ownerId_1_createdAt_-1',
      'ownerType_1_ownerId_1_nameLower_1',
      'ownerType_1_ownerId_1_displayMode_1',
      'post_channel_chrono_v1',
    ]);
  });

  it('unsets the obsolete lane owner type', async () => {
    const { db, calls } = makeDb();

    await migrationChannelAccounts.run(db);

    const updates = calls.filter((call) => call.op === 'updateMany');
    expect(updates).toEqual([
      {
        op: 'updateMany',
        collection: 'lanes',
        arg: { ownerType: { $exists: true } },
        options: { $unset: { ownerType: '' } },
      },
    ]);
  });

  it('fails before changing anything when a legacy channel post exists', async () => {
    const { db, calls } = makeDb({
      legacyChannelPost: { _id: 'legacy-post', channelId: 'legacy-channel' },
    });

    await expect(migrationChannelAccounts.run(db)).rejects.toThrow(
      'Migration 0026 cannot retire channels while legacy channel posts exist',
    );

    expect(calls).toEqual([
      {
        op: 'findOne',
        collection: 'posts',
        arg: { channelId: { $exists: true } },
        options: { projection: { _id: 1, channelId: 1 } },
      },
    ]);
  });

  it('drops the three retired collections', async () => {
    const { db, calls } = makeDb();

    await migrationChannelAccounts.run(db);

    expect(calls.filter((call) => call.op === 'dropCollection').map((call) => call.arg)).toEqual([
      'channels',
      'channelmembers',
      'channelfollows',
    ]);
  });

  it('is IDEMPOTENT: a second run drops nothing and still succeeds', async () => {
    // `dropIndex` on a missing index raises `IndexNotFound`; a migration that
    // throws on re-run blocks every later migration on a database that already
    // applied it.
    const { db } = makeDb({ existingIndexes: [], existingCollections: [] });

    await expect(migrationChannelAccounts.run(db)).resolves.toBeUndefined();
  });

  it('CONTROL: the idempotent run still creates the new indexes', async () => {
    // Otherwise "it did not throw" is satisfied by a run that did nothing at all.
    const { db, calls } = makeDb({ existingIndexes: [], existingCollections: [] });

    await migrationChannelAccounts.run(db);

    expect(calls.filter((call) => call.op === 'createIndex')).toHaveLength(3);
    expect(calls.filter((call) => call.op === 'dropIndex')).toHaveLength(0);
    expect(calls.filter((call) => call.op === 'dropCollection')).toHaveLength(0);
  });
});
