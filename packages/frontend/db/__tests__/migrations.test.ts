import { openNodeSqlite } from '@/test-support/nodeSqlite';
import { runMigrations, SCHEMA_VERSION } from '../migrations';

/** `mention.db` on real SQLite, with its schema version readable. */
function openDatabase() {
  const db = openNodeSqlite();
  return {
    ...db,
    userVersion: () =>
      db.getFirstSync<{ user_version: number }>('PRAGMA user_version')?.user_version,
  };
}

describe('mention.db migration', () => {
  it('drops the v16 post and feed tables and keeps only the link-preview cache', () => {
    const db = openDatabase();
    db.execSync(`
      CREATE TABLE posts (id TEXT PRIMARY KEY, raw_json TEXT);
      CREATE TABLE feed_items (feed_key TEXT, post_id TEXT REFERENCES posts(id) ON DELETE CASCADE);
      CREATE TABLE feed_meta (feed_key TEXT PRIMARY KEY);
      CREATE TABLE link_previews (url TEXT PRIMARY KEY);
      CREATE TABLE cache_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO posts VALUES ('p1', '{}');
      INSERT INTO feed_items VALUES ('for_you', 'p1');
      PRAGMA user_version = 16;
    `);

    runMigrations(db as never);

    expect(db.tables()).toEqual(['cache_metadata', 'link_previews']);
    expect(db.userVersion()).toBe(SCHEMA_VERSION);
  });

  it('creates the schema on a fresh file and leaves a current one alone', () => {
    const db = openDatabase();
    runMigrations(db as never);
    expect(db.tables()).toEqual(['cache_metadata', 'link_previews']);
    db.execSync("INSERT INTO link_previews (url, fetched_at) VALUES ('https://a.example', 1)");

    runMigrations(db as never);

    expect(db.getAllSync('SELECT url FROM link_previews')).toEqual([{ url: 'https://a.example' }]);
  });
});
