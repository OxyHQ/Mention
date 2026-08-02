import { beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import { migrationAdminScriptCursorIndex } from '../../migrations/0016-admin-script-cursor-index';

/**
 * Offline coverage for migration 0016 (admin-sweep resume-cursor identity).
 *
 * `autoIndex`/`autoCreate` are OFF in production, so this migration is the only
 * thing that creates the UNIQUE `{script, scope}` index. The Mongo `Db` /
 * collection are faked (createIndex captured) so the real call runs without a
 * database.
 *
 * The uniqueness flag is what is actually being pinned. A plain compound index
 * would satisfy every query the cursor makes and look completely healthy, while
 * letting two tasks against one scope each insert their own row — after which a
 * resume reads whichever it happens to find and silently re-walks or skips a
 * stretch of the corpus.
 */
function makeDb() {
  const createIndex = vi.fn().mockResolvedValue('script_1_scope_1');
  const collection = { collectionName: 'adminscriptcursors', createIndex };
  const db = { collection: vi.fn().mockReturnValue(collection) } as unknown as mongoose.mongo.Db;
  return { db, createIndex };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('migration 0016 — admin script cursor index', () => {
  it('targets the collection resolved from the model, not a hardcoded name', async () => {
    const { db } = makeDb();

    await migrationAdminScriptCursorIndex.run(db);

    expect(db.collection).toHaveBeenCalledWith('adminscriptcursors');
  });

  it('creates the UNIQUE { script, scope } identity', async () => {
    const { db, createIndex } = makeDb();

    await migrationAdminScriptCursorIndex.run(db);

    expect(createIndex).toHaveBeenCalledWith({ script: 1, scope: 1 }, { unique: true });
    expect(createIndex).toHaveBeenCalledTimes(1);
  });

  it('is re-runnable — `createIndex` with an identical spec is the no-op', async () => {
    const { db, createIndex } = makeDb();

    await migrationAdminScriptCursorIndex.run(db);
    await migrationAdminScriptCursorIndex.run(db);

    expect(createIndex).toHaveBeenNthCalledWith(2, { script: 1, scope: 1 }, { unique: true });
  });
});
