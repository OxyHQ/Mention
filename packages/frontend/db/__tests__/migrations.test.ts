import { runMigrations } from '../migrations';

describe('post cache schema migration', () => {
  it('invalidates v5 rows carrying local relation aliases before any v6 read', () => {
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
    expect(execSync).toHaveBeenLastCalledWith('PRAGMA user_version = 6');
  });
});
