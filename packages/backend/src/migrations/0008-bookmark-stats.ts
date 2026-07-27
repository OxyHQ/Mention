import type mongoose from 'mongoose';
import { logger } from '../utils/logger';
import { MIGRATION_BOOKMARK_STATS } from './constants';
import type { Migration } from './runner';

const BULK_SIZE = 500;

interface MongoIndexInfo {
  name: string;
  key: Record<string, unknown>;
  unique?: boolean;
}

interface RequiredIndex {
  readonly key: Record<string, 1 | -1>;
  readonly unique?: true;
}

const BOOKMARK_INDEXES: readonly RequiredIndex[] = [
  { key: { userId: 1, postId: 1 }, unique: true },
  { key: { userId: 1, createdAt: -1 } },
];

const LIKE_INDEXES: readonly RequiredIndex[] = [
  { key: { userId: 1, postId: 1 }, unique: true },
  { key: { postId: 1 } },
];

function hasSameKey(
  actual: Record<string, unknown>,
  expected: Record<string, 1 | -1>,
): boolean {
  const actualEntries = Object.entries(actual);
  const expectedEntries = Object.entries(expected);
  return (
    actualEntries.length === expectedEntries.length &&
    expectedEntries.every(
      ([field, direction], position) =>
        actualEntries[position]?.[0] === field &&
        actualEntries[position]?.[1] === direction,
    )
  );
}

function isNamespaceNotFound(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const mongoError = error as { code?: unknown; codeName?: unknown };
  return mongoError.code === 26 || mongoError.codeName === 'NamespaceNotFound';
}

async function readIndexes(
  collection: mongoose.mongo.Collection,
): Promise<MongoIndexInfo[]> {
  try {
    return (await collection.indexes()) as MongoIndexInfo[];
  } catch (error) {
    // createIndex below creates a collection that has not received data yet.
    if (isNamespaceNotFound(error)) return [];
    throw error;
  }
}

function assertNoNonUniqueEquivalent(
  collectionName: string,
  indexes: readonly MongoIndexInfo[],
  required: readonly RequiredIndex[],
): void {
  for (const spec of required) {
    if (!spec.unique) continue;
    const existing = indexes.find((index) => hasSameKey(index.key, spec.key));
    if (existing && existing.unique !== true) {
      throw new Error(
        `[migration] ${collectionName} index "${existing.name}" on ` +
          `${JSON.stringify(spec.key)} is non-unique; remove duplicates and replace ` +
          'the index with a unique index before retrying',
      );
    }
  }
}

async function ensureIndexes(
  collection: mongoose.mongo.Collection,
  existingIndexes: readonly MongoIndexInfo[],
  required: readonly RequiredIndex[],
): Promise<void> {
  for (const spec of required) {
    const existing = existingIndexes.find((index) => hasSameKey(index.key, spec.key));
    if (existing) continue;
    await collection.createIndex(spec.key, spec.unique ? { unique: true } : undefined);
  }
}

export const migrationBookmarkStats: Migration = {
  id: MIGRATION_BOOKMARK_STATS,

  async run(db, context): Promise<void> {
    const posts = db.collection('posts');
    const bookmarks = db.collection('bookmarks');
    const likes = db.collection('likes');

    // Production disables Mongoose autoIndex. Engagement commands rely on
    // these unique constraints for idempotency, so establish the constraints
    // before changing counters. An equivalent non-unique index is unsafe:
    // createIndex cannot silently strengthen it, and continuing would permit
    // duplicate relationships and counter drift.
    const [bookmarkIndexes, likeIndexes] = await Promise.all([
      readIndexes(bookmarks),
      readIndexes(likes),
    ]);
    assertNoNonUniqueEquivalent('bookmarks', bookmarkIndexes, BOOKMARK_INDEXES);
    assertNoNonUniqueEquivalent('likes', likeIndexes, LIKE_INDEXES);
    await ensureIndexes(bookmarks, bookmarkIndexes, BOOKMARK_INDEXES);
    await ensureIndexes(likes, likeIndexes, LIKE_INDEXES);
    await context?.assertLease();

    // Existing posts without bookmarks read as zero immediately. Exact non-zero
    // values are then projected from the authoritative Bookmark collection.
    const initialized = await posts.updateMany(
      { 'stats.savesCount': { $exists: false } },
      { $set: { 'stats.savesCount': 0 } },
    );
    await context?.assertLease();

    const operations: mongoose.mongo.AnyBulkWriteOperation[] = [];
    let projected = 0;
    const cursor = bookmarks.aggregate<{ _id: mongoose.Types.ObjectId; count: number }>([
      { $group: { _id: '$postId', count: { $sum: 1 } } },
    ]);

    for await (const row of cursor) {
      operations.push({
        updateOne: {
          filter: { _id: row._id },
          update: { $set: { 'stats.savesCount': row.count } },
        },
      });
      if (operations.length >= BULK_SIZE) {
        await context?.assertLease();
        const result = await posts.bulkWrite(operations, { ordered: false });
        projected += result.modifiedCount;
        operations.length = 0;
        await context?.assertLease();
      }
    }
    if (operations.length > 0) {
      await context?.assertLease();
      const result = await posts.bulkWrite(operations, { ordered: false });
      projected += result.modifiedCount;
      await context?.assertLease();
    }

    // Expand-only release: legacy metadata remains until dual-write,
    // reconciliation, read cutover and a later contract migration complete.
    logger.info('[migration] bookmark counters projected', {
      initialized: initialized.modifiedCount,
      projected,
    });
  },
};
