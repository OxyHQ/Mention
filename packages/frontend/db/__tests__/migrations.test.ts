import { runMigrations, SCHEMA_VERSION } from '../migrations';

describe('post cache schema migration', () => {
  it('invalidates rows written under an older shape before any read of the new one', () => {
    const execSync = jest.fn();
    const db = {
      getFirstSync: jest.fn(() => ({ user_version: 5 })),
      getAllSync: jest.fn(() => [
        { name: 'posts' },
        { name: 'feed_items' },
        { name: 'cache_metadata' },
      ]),
      execSync,
    };

    runMigrations(db as never);

    expect(execSync).toHaveBeenCalledWith('PRAGMA foreign_keys = OFF');
    expect(execSync).toHaveBeenCalledWith('DROP TABLE IF EXISTS "posts"');
    expect(execSync).toHaveBeenCalledWith('DROP TABLE IF EXISTS "feed_items"');
    expect(execSync).toHaveBeenCalledWith('DROP TABLE IF EXISTS "cache_metadata"');
    // Read off the constant rather than pinned to a literal: WHICH version is
    // current is `cacheShapeVersion.test.ts`'s job (it pins the persisted key
    // set against it), and duplicating the number here only makes a legitimate
    // bump fail in a second place that says nothing new.
    expect(execSync).toHaveBeenLastCalledWith(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  });
});
