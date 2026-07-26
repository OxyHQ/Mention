import { beforeEach, describe, expect, it, vi } from 'vitest';
import type mongoose from 'mongoose';
import { migrationPostRecentRepliers } from '../../migrations/0009-post-recent-repliers';
import {
  POST_RECENT_REPLIER_COLLECTION,
  POST_RECENT_REPLIER_INDEX,
} from '../../models/PostRecentReplier';

interface ReplyRow {
  parentPostId: string;
  oxyUserId: string;
  createdAt: Date;
}

function makeDb(sourceRows: ReplyRow[]) {
  const sort = vi.fn();
  const cursor: {
    sort: typeof sort;
    [Symbol.asyncIterator]: () => AsyncGenerator<ReplyRow>;
  } = {
    sort,
    async *[Symbol.asyncIterator]() {
      for (const row of sourceRows) yield row;
    },
  };
  sort.mockReturnValue(cursor);

  const find = vi.fn().mockReturnValue(cursor);
  const deleteMany = vi.fn().mockResolvedValue({ deletedCount: 0 });
  const createIndex = vi.fn().mockResolvedValue(POST_RECENT_REPLIER_INDEX);
  const bulkBatches: unknown[][] = [];
  const bulkWrite = vi.fn().mockImplementation(async (operations: unknown[]) => {
    bulkBatches.push([...operations]);
    return { modifiedCount: operations.length };
  });

  const collections = {
    posts: { find },
    [POST_RECENT_REPLIER_COLLECTION]: { deleteMany, createIndex, bulkWrite },
  };
  const db = {
    collection: vi.fn((name: keyof typeof collections) => collections[name]),
  } as unknown as mongoose.mongo.Db;

  return {
    db,
    find,
    sort,
    deleteMany,
    createIndex,
    bulkWrite,
    bulkBatches,
  };
}

describe('migration 0009 - recent replier projection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('streams string parent ids and projects only the three newest unique users', async () => {
    const date = (hour: number) => new Date(`2026-01-01T${String(hour).padStart(2, '0')}:00:00.000Z`);
    const sourceRows: ReplyRow[] = [
      { parentPostId: 'parent-a', oxyUserId: 'alice', createdAt: date(12) },
      { parentPostId: 'parent-a', oxyUserId: 'bob', createdAt: date(11) },
      { parentPostId: 'parent-a', oxyUserId: 'alice', createdAt: date(10) },
      { parentPostId: 'parent-a', oxyUserId: 'carol', createdAt: date(9) },
      { parentPostId: 'parent-a', oxyUserId: 'dave', createdAt: date(8) },
      { parentPostId: 'parent-b', oxyUserId: 'erin', createdAt: date(7) },
    ];
    const { db, find, sort, bulkBatches } = makeDb(sourceRows);

    await migrationPostRecentRepliers.run(db);

    expect(find.mock.calls[0][0]).toMatchObject({
      parentPostId: { $type: 'string', $ne: '' },
    });
    expect(sort).toHaveBeenCalledWith({ parentPostId: 1, createdAt: -1 });

    const operations = bulkBatches.flat() as Array<{
      updateOne: {
        filter: { postId: string };
        update: { $set: { repliers: Array<{ oxyUserId: string }> } };
      };
    }>;
    const parentA = operations.find(
      (operation) => operation.updateOne.filter.postId === 'parent-a',
    );
    expect(parentA?.updateOne.update.$set.repliers.map((entry) => entry.oxyUserId)).toEqual([
      'alice',
      'bob',
      'carol',
    ]);
    expect(parentA?.updateOne.update.$set.repliers).toHaveLength(3);
  });

  it('rebuilds idempotently and creates the explicit unique postId index', async () => {
    const { db, deleteMany, createIndex } = makeDb([]);

    await migrationPostRecentRepliers.run(db);

    expect(deleteMany).toHaveBeenCalledWith({});
    expect(createIndex).toHaveBeenCalledWith(
      { postId: 1 },
      { unique: true, name: POST_RECENT_REPLIER_INDEX },
    );
    expect(db.collection).toHaveBeenCalledWith(POST_RECENT_REPLIER_COLLECTION);
  });
});
