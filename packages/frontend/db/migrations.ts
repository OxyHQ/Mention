/**
 * SQLite schema — single clean definition, drop-and-recreate on version change.
 *
 * The SQLite database is a purely local cache (posts, feeds, link previews).
 * The user cache lives in React Query (in-memory, web + native), so posts carry
 * their author inline (user_json) — there is no separate user table here.
 *
 * There is exactly ONE schema. On a version bump we simply reset the cache —
 * drop every table and recreate from this definition. No data-preserving
 * migrations: a local cache is cheap to rebuild from the network.
 */

import type * as SQLite from 'expo-sqlite';
import { createScopedLogger } from '@/lib/logger';

const logger = createScopedLogger('Schema');

/**
 * Schema version. Bump this whenever the table definitions below change —
 * the next `getDb()` will drop the old cache and recreate it cleanly.
 */
const SCHEMA_VERSION = 3;

/**
 * Create the full schema from scratch. Idempotent (IF NOT EXISTS).
 */
function createSchema(db: SQLite.SQLiteDatabase): void {
  // Posts — hybrid: indexed columns for queries, JSON for nested content.
  // Authors are stored inline (user_json); there is no separate user table.
  db.execSync(`
    CREATE TABLE IF NOT EXISTS posts (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'text',
      parent_post_id TEXT,
      original_post_id TEXT,
      quoted_post_id TEXT,
      content_json TEXT NOT NULL,
      attachments_json TEXT,
      link_previews_json TEXT,
      permissions_json TEXT,
      boost_json TEXT,
      context_json TEXT,
      user_json TEXT NOT NULL,
      likes_count INTEGER DEFAULT 0,
      downvotes_count INTEGER DEFAULT 0,
      boosts_count INTEGER DEFAULT 0,
      replies_count INTEGER DEFAULT 0,
      saves_count INTEGER DEFAULT 0,
      views_count INTEGER DEFAULT 0,
      impressions_count INTEGER DEFAULT 0,
      is_liked INTEGER DEFAULT 0,
      is_downvoted INTEGER DEFAULT 0,
      is_boosted INTEGER DEFAULT 0,
      is_saved INTEGER DEFAULT 0,
      is_owner INTEGER DEFAULT 0,
      visibility TEXT DEFAULT 'public',
      created_at TEXT NOT NULL,
      updated_at TEXT,
      fetched_at INTEGER NOT NULL,
      raw_json TEXT
    )
  `);

  // Feed items — join table linking feeds to posts with ordering.
  db.execSync(`
    CREATE TABLE IF NOT EXISTS feed_items (
      feed_key TEXT NOT NULL,
      post_id TEXT NOT NULL,
      position INTEGER NOT NULL,
      slice_json TEXT,
      inserted_at INTEGER NOT NULL,
      PRIMARY KEY (feed_key, post_id),
      FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE
    )
  `);

  // Feed metadata — cursor, hasMore, etc. per feed.
  db.execSync(`
    CREATE TABLE IF NOT EXISTS feed_meta (
      feed_key TEXT PRIMARY KEY,
      has_more INTEGER DEFAULT 1,
      next_cursor TEXT,
      total_count INTEGER DEFAULT 0,
      last_updated INTEGER NOT NULL,
      filters_json TEXT
    )
  `);

  // Link preview cache.
  db.execSync(`
    CREATE TABLE IF NOT EXISTS link_previews (
      url TEXT PRIMARY KEY,
      title TEXT,
      description TEXT,
      image TEXT,
      site_name TEXT,
      favicon TEXT,
      error TEXT,
      fetched_at INTEGER NOT NULL,
      ttl_ms INTEGER DEFAULT 1800000
    )
  `);

  // Indices.
  db.execSync('CREATE INDEX IF NOT EXISTS idx_posts_user_id ON posts(user_id)');
  db.execSync('CREATE INDEX IF NOT EXISTS idx_posts_parent ON posts(parent_post_id) WHERE parent_post_id IS NOT NULL');
  db.execSync('CREATE INDEX IF NOT EXISTS idx_posts_original ON posts(original_post_id) WHERE original_post_id IS NOT NULL');
  db.execSync('CREATE INDEX IF NOT EXISTS idx_posts_created ON posts(created_at DESC)');
  db.execSync('CREATE INDEX IF NOT EXISTS idx_posts_saved ON posts(is_saved) WHERE is_saved = 1');
  db.execSync('CREATE INDEX IF NOT EXISTS idx_posts_fetched ON posts(fetched_at)');
  db.execSync('CREATE INDEX IF NOT EXISTS idx_feed_items_position ON feed_items(feed_key, position)');
  db.execSync('CREATE INDEX IF NOT EXISTS idx_feed_items_post_id ON feed_items(post_id)');
  db.execSync('CREATE INDEX IF NOT EXISTS idx_link_previews_expiry ON link_previews(fetched_at)');
}

/**
 * Drop every user table currently in the database file. Discovered dynamically
 * from sqlite_master so no table name is hardcoded — this wipes whatever an
 * older build left behind. Foreign keys are disabled for the duration so drop
 * order does not matter (this is a full local-cache reset).
 */
function dropAllTables(db: SQLite.SQLiteDatabase): void {
  const tables = db.getAllSync<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
  );
  db.execSync('PRAGMA foreign_keys = OFF');
  for (const { name } of tables) {
    db.execSync(`DROP TABLE IF EXISTS "${name}"`);
  }
  db.execSync('PRAGMA foreign_keys = ON');
}

/**
 * Ensure the database matches the current schema.
 *
 * Uses SQLite's built-in `PRAGMA user_version`. If it already matches, the
 * schema is current and we're done. Otherwise — a fresh DB, or one left by an
 * older build (which never set `user_version`, so it reads as 0) — we drop
 * every existing table and recreate the schema from the single clean definition
 * above. The cache is rebuilt from the network on next use.
 */
export function runMigrations(db: SQLite.SQLiteDatabase): void {
  const row = db.getFirstSync<{ user_version: number }>('PRAGMA user_version');
  const currentVersion = row?.user_version ?? 0;

  if (currentVersion === SCHEMA_VERSION) {
    logger.debug(`Database schema up to date at v${SCHEMA_VERSION}`);
    return;
  }

  if (currentVersion !== 0) {
    logger.debug(`Schema v${currentVersion} != v${SCHEMA_VERSION} — resetting local cache`);
  }
  dropAllTables(db);
  createSchema(db);
  db.execSync(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  logger.debug(`Database schema created at v${SCHEMA_VERSION}`);
}
