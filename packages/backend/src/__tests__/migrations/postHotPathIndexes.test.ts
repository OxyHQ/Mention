import { describe, expect, it, vi } from 'vitest';
import type mongoose from 'mongoose';
import {
  POST_HOT_PATH_INDEXES,
  POST_TEXT_SEARCH_INDEX,
} from '../../indexes/manifest';
import { migrationPostHotPathIndexes } from '../../migrations/0010-post-hot-path-indexes';

interface FakeIndex {
  name: string;
  key: Record<string, unknown>;
  weights?: Record<string, unknown>;
  default_language?: string;
  language_override?: string;
}

function createFakeCollection(initialIndexes: FakeIndex[] = []) {
  const storedIndexes = [...initialIndexes];
  const createIndex = vi.fn(
    async (key: Record<string, unknown>, options: Record<string, unknown> = {}) => {
      if (Object.values(key).includes('text')) {
        storedIndexes.push({
          name: String(options.name),
          // listIndexes represents text keys through the internal _fts shape.
          key: { _fts: 'text', _ftsx: 1 },
          weights: options.weights as Record<string, unknown>,
          default_language: String(options.default_language),
          language_override: String(options.language_override),
        });
      }
      return String(options.name ?? 'created');
    },
  );
  const dropIndex = vi.fn(async (name: string) => {
    const position = storedIndexes.findIndex((index) => index.name === name);
    if (position >= 0) storedIndexes.splice(position, 1);
  });
  return {
    collection: {
      createIndex,
      dropIndex,
      indexes: vi.fn(async () => [...storedIndexes]),
      updateMany: vi.fn().mockResolvedValue({ modifiedCount: 0 }),
    },
    createIndex,
    dropIndex,
  };
}

describe('migration 0010 - Post hot-path indexes', () => {
  it('creates every versioned btree index plus the exact text index', async () => {
    const { collection, createIndex, dropIndex } = createFakeCollection();
    const db = {
      collection: vi.fn().mockReturnValue(collection),
    } as unknown as mongoose.mongo.Db;

    await migrationPostHotPathIndexes.run(db);

    expect(db.collection).toHaveBeenCalledWith('posts');
    expect(collection.updateMany).toHaveBeenCalledOnce();
    expect(createIndex).toHaveBeenCalledTimes(POST_HOT_PATH_INDEXES.length + 1);
    for (const index of POST_HOT_PATH_INDEXES) {
      expect(createIndex).toHaveBeenCalledWith(index.key, { name: index.name });
    }
    expect(createIndex).toHaveBeenCalledWith(
      POST_TEXT_SEARCH_INDEX.key,
      {
        name: POST_TEXT_SEARCH_INDEX.name,
        default_language: POST_TEXT_SEARCH_INDEX.default_language,
        language_override: POST_TEXT_SEARCH_INDEX.language_override,
        weights: POST_TEXT_SEARCH_INDEX.weights,
      },
    );
    expect(dropIndex).not.toHaveBeenCalled();
  });

  it('accepts an already-compatible text index without rebuilding it', async () => {
    const { collection, createIndex, dropIndex } = createFakeCollection([
      {
        name: 'existing-compatible-text-index',
        key: { _fts: 'text', _ftsx: 1 },
        weights: { ...POST_TEXT_SEARCH_INDEX.weights },
        default_language: POST_TEXT_SEARCH_INDEX.default_language,
        language_override: POST_TEXT_SEARCH_INDEX.language_override,
      },
    ]);
    const db = {
      collection: vi.fn().mockReturnValue(collection),
    } as unknown as mongoose.mongo.Db;

    await migrationPostHotPathIndexes.run(db);

    expect(
      createIndex.mock.calls.filter(([key]) =>
        Object.values(key as Record<string, unknown>).includes('text')),
    ).toHaveLength(0);
    expect(dropIndex).not.toHaveBeenCalled();
  });

  it('replaces only the known retired content.text index', async () => {
    const { collection, createIndex, dropIndex } = createFakeCollection([
      {
        name: 'content.text_text',
        key: { _fts: 'text', _ftsx: 1 },
        weights: { 'content.text': 1 },
        default_language: 'english',
        language_override: 'textSearchLanguage',
      },
    ]);
    const db = {
      collection: vi.fn().mockReturnValue(collection),
    } as unknown as mongoose.mongo.Db;

    await migrationPostHotPathIndexes.run(db);

    expect(dropIndex).toHaveBeenCalledTimes(1);
    expect(dropIndex).toHaveBeenCalledWith('content.text_text');
    expect(createIndex).toHaveBeenCalledWith(
      POST_TEXT_SEARCH_INDEX.key,
      expect.objectContaining({
        name: POST_TEXT_SEARCH_INDEX.name,
        weights: POST_TEXT_SEARCH_INDEX.weights,
      }),
    );
  });

  it('fails closed instead of dropping an unknown incompatible text index', async () => {
    const { collection, dropIndex } = createFakeCollection([
      {
        name: 'operator_managed_text',
        key: { _fts: 'text', _ftsx: 1 },
        weights: { title: 10 },
        default_language: 'english',
        language_override: 'language',
      },
    ]);
    const db = {
      collection: vi.fn().mockReturnValue(collection),
    } as unknown as mongoose.mongo.Db;

    await expect(migrationPostHotPathIndexes.run(db)).rejects.toThrow(
      'incompatible text index "operator_managed_text"',
    );
    expect(dropIndex).not.toHaveBeenCalled();
  });
});
