import type mongoose from 'mongoose';
import {
  POST_HOT_PATH_INDEXES,
  POST_TEXT_SEARCH_INDEX,
} from '../indexes/manifest';
import { logger } from '../utils/logger';
import { MIGRATION_POST_HOT_PATH_INDEXES } from './constants';
import type { Migration } from './runner';

interface MongoIndexInfo {
  name: string;
  key: Record<string, unknown>;
  weights?: Record<string, unknown>;
  default_language?: unknown;
  language_override?: unknown;
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
    if (isNamespaceNotFound(error)) return [];
    throw error;
  }
}

function sameDocument(
  actual: Record<string, unknown> | undefined,
  expected: Record<string, unknown>,
): boolean {
  if (!actual) return false;
  const actualEntries = Object.entries(actual);
  const expectedEntries = Object.entries(expected);
  return (
    actualEntries.length === expectedEntries.length &&
    expectedEntries.every(([key, value]) => actual[key] === value)
  );
}

function isTextIndex(index: MongoIndexInfo): boolean {
  return (
    index.key._fts === 'text' ||
    Object.values(index.key).includes('text') ||
    index.weights !== undefined
  );
}

function isExactPostTextIndex(index: MongoIndexInfo): boolean {
  return (
    isTextIndex(index) &&
    sameDocument(index.weights, { ...POST_TEXT_SEARCH_INDEX.weights }) &&
    index.default_language === POST_TEXT_SEARCH_INDEX.default_language &&
    index.language_override === POST_TEXT_SEARCH_INDEX.language_override
  );
}

function isRetiredPostTextIndex(index: MongoIndexInfo): boolean {
  return (
    index.name === 'content.text_text' &&
    sameDocument(index.weights, { 'content.text': 1 })
  );
}

async function ensurePostTextIndex(
  posts: mongoose.mongo.Collection,
  assertLease: (() => Promise<void>) | undefined,
): Promise<void> {
  let indexes = await readIndexes(posts);
  const currentTextIndex = indexes.find(isTextIndex);

  if (currentTextIndex && isExactPostTextIndex(currentTextIndex)) {
    return;
  }

  if (currentTextIndex) {
    if (!isRetiredPostTextIndex(currentTextIndex)) {
      throw new Error(
        `[migration] posts has incompatible text index "${currentTextIndex.name}" ` +
          `with weights ${JSON.stringify(currentTextIndex.weights ?? {})}; ` +
          `expected ${JSON.stringify(POST_TEXT_SEARCH_INDEX.weights)}`,
      );
    }
    await assertLease?.();
    await posts.dropIndex(currentTextIndex.name);
    await assertLease?.();
    indexes = indexes.filter((index) => index.name !== currentTextIndex.name);
  }

  if (!indexes.some(isExactPostTextIndex)) {
    await assertLease?.();
    await posts.createIndex(
      { ...POST_TEXT_SEARCH_INDEX.key },
      {
        name: POST_TEXT_SEARCH_INDEX.name,
        default_language: POST_TEXT_SEARCH_INDEX.default_language,
        language_override: POST_TEXT_SEARCH_INDEX.language_override,
        weights: { ...POST_TEXT_SEARCH_INDEX.weights },
      },
    );
    await assertLease?.();
  }

  const verified = (await readIndexes(posts)).find(isExactPostTextIndex);
  if (!verified) {
    throw new Error(
      `[migration] failed to verify required posts text index "${POST_TEXT_SEARCH_INDEX.name}"`,
    );
  }
}

export const migrationPostHotPathIndexes: Migration = {
  id: MIGRATION_POST_HOT_PATH_INDEXES,

  async run(db: mongoose.mongo.Db, context): Promise<void> {
    const posts = db.collection('posts');
    await context?.assertLease();
    await posts.updateMany(
      { hasLinks: { $exists: false } },
      [
        {
          $set: {
            hasLinks: {
              $anyElementTrue: {
                $map: {
                  input: { $ifNull: ['$content.variants', []] },
                  as: 'variant',
                  in: {
                    $regexMatch: {
                      input: { $ifNull: ['$$variant.text', ''] },
                      regex: 'https?://',
                      options: 'i',
                    },
                  },
                },
              },
            },
          },
        },
      ],
    );
    await context?.assertLease();

    for (const index of POST_HOT_PATH_INDEXES) {
      await context?.assertLease();
      await posts.createIndex(index.key, {
        name: index.name,
      });
      await context?.assertLease();
    }

    await ensurePostTextIndex(posts, context?.assertLease);

    logger.info('[migration] ensured versioned Post hot-path indexes', {
      indexes: [
        ...POST_HOT_PATH_INDEXES.map((index) => index.name),
        POST_TEXT_SEARCH_INDEX.name,
      ],
    });
  },
};
