/**
 * `mention.db`: the device's local cache outside the data store, one clean
 * definition, dropped and recreated on a version change.
 *
 * Posts and feeds are not here: they live in each account's own data store
 * (`data/`, `@oxy.so/bloom-data`, the SDK's `oxy-data-<account>.db`). What is left is
 * the link-preview cache and the record of which viewer it belongs to.
 *
 * There is exactly ONE schema. On a version bump the cache is reset: every
 * table is dropped and recreated from this definition. No data-preserving
 * migrations: a local cache is cheap to rebuild from the network.
 */

import type * as SQLite from 'expo-sqlite';
import { createLogger } from '@oxy.so/core/logger';

const logger = createLogger('Schema');

/**
 * Schema version of `mention.db`. Bump it whenever a table definition below
 * changes, or the shape of what one stores does.
 *
 * v17 drops `posts`, `feed_items` and `feed_meta`: posts and feeds moved to the
 * account's data store, whose record shape is `data/posts`' `POST_SHAPE_VERSION`
 * (v1 to v16 were that shape's history, recorded there).
 */
export const SCHEMA_VERSION = 17;

/** Create the full schema from scratch. Idempotent (IF NOT EXISTS). */
function createSchema(db: SQLite.SQLiteDatabase): void {
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

  // Which viewer the cache belongs to. The identity boundary claims it before
  // any descendant can render; a different (or missing) owner wipes it first.
  db.execSync(`
    CREATE TABLE IF NOT EXISTS cache_metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);

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
 * schema is current and we're done. Otherwise (a fresh DB, or one left by an
 * older build, including v16's post and feed tables) every existing table is
 * dropped and the schema recreated from the single clean definition above.
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
