import { describe, expect, it, vi } from 'vitest';
import type mongoose from 'mongoose';
import { migrationBookmarkStats } from '../../migrations/0008-bookmark-stats';

interface FakeIndex {
  name: string;
  key: Record<string, number>;
  unique?: boolean;
}

function cursor<T>(rows: readonly T[] = []): AsyncIterable<T> {
  return {
    async *[Symbol.asyncIterator]() {
      yield* rows;
    },
  };
}

function fakeCollection(indexes: FakeIndex[] = [], aggregateRows: readonly unknown[] = []) {
  return {
    indexes: vi.fn().mockResolvedValue(indexes),
    createIndex: vi.fn().mockResolvedValue('created'),
    updateMany: vi.fn().mockResolvedValue({ modifiedCount: 0 }),
    aggregate: vi.fn().mockReturnValue(cursor(aggregateRows)),
    bulkWrite: vi.fn().mockResolvedValue({ modifiedCount: 0 }),
  };
}

describe('migration 0008 - Bookmark counters and engagement indexes', () => {
  it('ensures command/query indexes before the expand-only counter backfill', async () => {
    const posts = fakeCollection();
    const bookmarks = fakeCollection();
    const likes = fakeCollection();
    const db = {
      collection: vi.fn((name: string) => {
        if (name === 'posts') return posts;
        if (name === 'bookmarks') return bookmarks;
        if (name === 'likes') return likes;
        throw new Error(`unexpected collection ${name}`);
      }),
    } as unknown as mongoose.mongo.Db;
    const assertLease = vi.fn().mockResolvedValue(undefined);

    await migrationBookmarkStats.run(db, {
      signal: new AbortController().signal,
      assertLease,
    });

    expect(bookmarks.createIndex).toHaveBeenCalledWith(
      { userId: 1, postId: 1 },
      { unique: true },
    );
    expect(bookmarks.createIndex).toHaveBeenCalledWith(
      { userId: 1, createdAt: -1 },
      undefined,
    );
    expect(likes.createIndex).toHaveBeenCalledWith(
      { userId: 1, postId: 1 },
      { unique: true },
    );
    expect(likes.createIndex).toHaveBeenCalledWith({ postId: 1 }, undefined);

    const lastIndexWrite = Math.max(
      ...bookmarks.createIndex.mock.invocationCallOrder,
      ...likes.createIndex.mock.invocationCallOrder,
    );
    expect(lastIndexWrite).toBeLessThan(posts.updateMany.mock.invocationCallOrder[0]);
    expect(posts.updateMany).toHaveBeenCalledTimes(1);
    expect(posts.updateMany).toHaveBeenCalledWith(
      { 'stats.savesCount': { $exists: false } },
      { $set: { 'stats.savesCount': 0 } },
    );
    expect(posts.updateMany.mock.calls).not.toContainEqual([
      expect.anything(),
      expect.objectContaining({ $unset: expect.anything() }),
    ]);
    expect(assertLease).toHaveBeenCalled();
  });

  it('checks the migration lease before and after every counter batch', async () => {
    const rows = Array.from({ length: 501 }, (_, position) => ({
      _id: `post-${position}`,
      count: position + 1,
    }));
    const posts = fakeCollection();
    const bookmarks = fakeCollection([], rows);
    const likes = fakeCollection();
    const db = {
      collection: vi.fn((name: string) => {
        if (name === 'posts') return posts;
        if (name === 'bookmarks') return bookmarks;
        if (name === 'likes') return likes;
        throw new Error(`unexpected collection ${name}`);
      }),
    } as unknown as mongoose.mongo.Db;
    const assertLease = vi.fn().mockResolvedValue(undefined);

    await migrationBookmarkStats.run(db, {
      signal: new AbortController().signal,
      assertLease,
    });

    expect(posts.bulkWrite).toHaveBeenCalledTimes(2);
    expect(assertLease).toHaveBeenCalledTimes(6);
  });

  it.each([
    ['bookmarks', 'bookmarks_user_post', { userId: 1, postId: 1 }],
    ['likes', 'likes_user_post', { userId: 1, postId: 1 }],
  ])(
    'fails before backfill when %s has an equivalent non-unique index',
    async (collectionName, indexName, key) => {
      const posts = fakeCollection();
      const bookmarks = fakeCollection(
        collectionName === 'bookmarks' ? [{ name: indexName, key }] : [],
      );
      const likes = fakeCollection(
        collectionName === 'likes' ? [{ name: indexName, key }] : [],
      );
      const db = {
        collection: vi.fn((name: string) => {
          if (name === 'posts') return posts;
          if (name === 'bookmarks') return bookmarks;
          if (name === 'likes') return likes;
          throw new Error(`unexpected collection ${name}`);
        }),
      } as unknown as mongoose.mongo.Db;

      await expect(migrationBookmarkStats.run(db)).rejects.toThrow(
        new RegExp(`${collectionName} index "${indexName}".*is non-unique`),
      );
      expect(posts.updateMany).not.toHaveBeenCalled();
      expect(bookmarks.createIndex).not.toHaveBeenCalled();
      expect(likes.createIndex).not.toHaveBeenCalled();
    },
  );

  it('accepts existing unique relationship indexes without recreating them', async () => {
    const posts = fakeCollection();
    const bookmarks = fakeCollection([
      {
        name: 'bookmark_relation_unique',
        key: { userId: 1, postId: 1 },
        unique: true,
      },
      { name: 'bookmark_listing', key: { userId: 1, createdAt: -1 } },
    ]);
    const likes = fakeCollection([
      {
        name: 'like_relation_unique',
        key: { userId: 1, postId: 1 },
        unique: true,
      },
      { name: 'like_by_post', key: { postId: 1 } },
    ]);
    const db = {
      collection: vi.fn((name: string) => {
        if (name === 'posts') return posts;
        if (name === 'bookmarks') return bookmarks;
        if (name === 'likes') return likes;
        throw new Error(`unexpected collection ${name}`);
      }),
    } as unknown as mongoose.mongo.Db;

    await migrationBookmarkStats.run(db);

    expect(bookmarks.createIndex).not.toHaveBeenCalled();
    expect(likes.createIndex).not.toHaveBeenCalled();
    expect(posts.updateMany).toHaveBeenCalledTimes(1);
  });
});
