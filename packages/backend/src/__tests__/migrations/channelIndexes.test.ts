import { describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import { migrationChannelIndexes } from '../../migrations/0024-channel-indexes';
import { migrationChannelFollowUserIndex } from '../../migrations/0025-channel-follow-user-index';
import { MIGRATION_CHANNEL_FOLLOW_USER_INDEX, MIGRATION_CHANNEL_INDEXES } from '../../migrations/constants';
import { Post } from '../../models/Post';

/**
 * Offline coverage for the Channels migration.
 *
 * `autoIndex`/`autoCreate` are OFF in production, so this migration is the ONLY
 * thing that creates the indexes its schemas declare. The Mongo `Db` is faked
 * (every `createIndex` call captured) so the real code runs with no database.
 *
 * What is actually being guarded:
 *
 *  - the three UNIQUE constraints really carry `unique: true`. Without them, a
 *    channel handle stops being a global identity, a repeated invite writes a
 *    second membership row, and following a channel stops being idempotent —
 *    none of which is visible from the outside;
 *  - `post_channel_chrono_v1` is PARTIAL, not sparse. A compound sparse index
 *    covers every document carrying ANY of its keys, and every post has
 *    `visibility`, so `sparse` would index the whole collection and save nothing;
 *  - the migration's index specs match what the SCHEMA declares. A migration that
 *    drifted from its schema would create the wrong index in production and
 *    nothing local would ever notice, because local runs use `autoIndex`.
 *
 * That last comparison now covers `posts` ONLY. `Channel`, `ChannelMember` and
 * `ChannelFollow` moved to Postgres and their Mongoose models are gone, so a
 * drift check against them has no referent left — and these two migrations are
 * FROZEN HISTORY that repairs pre-cutover Mongo collections, which is why they
 * name those collections with literals of their own and no longer read one off a
 * model. `Post` is still a Mongoose model, so its comparison survives unchanged.
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

describe('migration 0024 — channel indexes', () => {
  it('is registered under its own id, after the two lane migrations', () => {
    expect(migrationChannelIndexes.id).toBe(MIGRATION_CHANNEL_INDEXES);
    expect(MIGRATION_CHANNEL_INDEXES).toBe('0024-channel-indexes');
  });

  it('creates every index for the three new collections and the one on posts', async () => {
    const { db, calls } = makeDb();

    await migrationChannelIndexes.run(db);

    expect(calls.map((call) => ({ collection: call.collection, key: call.key }))).toEqual([
      { collection: 'channels', key: { handleLower: 1 } },
      { collection: 'channels', key: { ownerOxyUserId: 1, createdAt: -1 } },
      { collection: 'channels', key: { visibility: 1, followerCount: -1, _id: -1 } },
      { collection: 'channelmembers', key: { channelId: 1, oxyUserId: 1 } },
      { collection: 'channelmembers', key: { channelId: 1, status: 1 } },
      { collection: 'channelmembers', key: { oxyUserId: 1, status: 1 } },
      { collection: 'channelfollows', key: { oxyUserId: 1, channelId: 1 } },
      { collection: 'channelfollows', key: { channelId: 1, notify: 1, _id: 1 } },
      {
        collection: 'posts',
        key: { channelId: 1, visibility: 1, status: 1, createdAt: -1, _id: -1 },
      },
    ]);
  });

  it('marks all THREE unique constraints unique — and nothing else', async () => {
    const { db, calls } = makeDb();

    await migrationChannelIndexes.run(db);

    const unique = calls.filter((call) => call.options?.unique === true).map((call) => call.key);
    expect(unique).toEqual([
      { handleLower: 1 },
      { channelId: 1, oxyUserId: 1 },
      { oxyUserId: 1, channelId: 1 },
    ]);
  });

  it('creates post_channel_chrono_v1 PARTIAL, never sparse', async () => {
    const { db, calls } = makeDb();

    await migrationChannelIndexes.run(db);

    const postIndex = calls.find((call) => call.collection === 'posts');
    expect(postIndex?.options).toEqual({
      name: 'post_channel_chrono_v1',
      partialFilterExpression: { channelId: { $type: 'string' } },
    });
    expect(postIndex?.options).not.toHaveProperty('sparse');
  });

  it('matches the spec the Post SCHEMA declares — the two cannot drift', async () => {
    const { db, calls } = makeDb();

    await migrationChannelIndexes.run(db);

    const declared = Post.schema
      .indexes()
      .find(([, options]) => options?.name === 'post_channel_chrono_v1');
    const created = calls.find((call) => call.options?.name === 'post_channel_chrono_v1');

    expect(declared).toBeDefined();
    expect(created).toBeDefined();
    expect(created?.key).toEqual(declared?.[0]);
    expect(created?.options?.partialFilterExpression).toEqual(
      declared?.[1]?.partialFilterExpression,
    );
  });
});

/**
 * Migration 0025 — the reader's own subscription list.
 *
 * Its own file rather than an edit to 0024 BECAUSE the runner records an applied
 * migration and skips it forever: appending to 0024 would be a silent no-op on
 * any database that already ran it, which is the same trap
 * `POST_HOT_PATH_INDEXES` documents for migration 0010.
 */
describe('migration 0025 — channel_follow_by_user_v1', () => {
  it('is registered under its own id, after the channel indexes', () => {
    expect(migrationChannelFollowUserIndex.id).toBe(MIGRATION_CHANNEL_FOLLOW_USER_INDEX);
    expect(MIGRATION_CHANNEL_FOLLOW_USER_INDEX).toBe('0025-channel-follow-user-index');
    expect(MIGRATION_CHANNEL_FOLLOW_USER_INDEX > MIGRATION_CHANNEL_INDEXES).toBe(true);
  });

  it('creates the keyset index the following list pages on', async () => {
    const { db, calls } = makeDb();

    await migrationChannelFollowUserIndex.run(db);

    expect(calls).toEqual([
      {
        collection: 'channelfollows',
        key: { oxyUserId: 1, createdAt: -1, _id: -1 },
        options: { name: 'channel_follow_by_user_v1' },
      },
    ]);
  });

  it('carries `_id` IN the index, not as a residual tiebreak', async () => {
    // A keyset cursor cannot rely on an ordering the index does not produce.
    const { db, calls } = makeDb();

    await migrationChannelFollowUserIndex.run(db);

    expect(Object.keys(calls[0].key)).toEqual(['oxyUserId', 'createdAt', '_id']);
  });

  it('0024 does NOT create it — that is what makes 0025 necessary', async () => {
    // If 0024 grew this index instead, a database that already recorded 0024 as
    // applied would never get it, and nothing local would notice.
    const { db, calls } = makeDb();

    await migrationChannelIndexes.run(db);

    expect(calls.some((call) => call.options?.name === 'channel_follow_by_user_v1')).toBe(false);
  });
});
