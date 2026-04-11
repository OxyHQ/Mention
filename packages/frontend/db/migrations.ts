/**
 * Schema migrations — forward-only, versioned, transactional.
 * 
 * Each migration runs inside a transaction.
 * The schema_version table tracks which migrations have been applied.
 */

import type * as SQLite from 'expo-sqlite';
import { createScopedLogger } from '@/lib/logger';

const logger = createScopedLogger('Migrations');

type Migration = {
  version: number;
  description: string;
  up: (db: SQLite.SQLiteDatabase) => void;
};

/**
 * Migration registry — append-only. Never modify existing migrations.
 */
const migrations: Migration[] = [
  {
    version: 1,
    description: 'Phase 1 — Core tables: actors, posts, feed_items, feed_meta, link_previews',
    up: (db) => {
      // Actors (users) table
      db.execSync(`
        CREATE TABLE IF NOT EXISTS actors (
          id TEXT PRIMARY KEY,
          username TEXT,
          display_name TEXT,
          avatar_url TEXT,
          handle TEXT,
          is_verified INTEGER DEFAULT 0,
          bio TEXT,
          badges_json TEXT,
          is_full INTEGER DEFAULT 0,
          extra_json TEXT,
          fetched_at INTEGER NOT NULL
        )
      `);

      // Posts table — hybrid: indexed columns for queries, JSON for nested content
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
          link_preview_json TEXT,
          permissions_json TEXT,
          repost_json TEXT,
          context_json TEXT,
          user_json TEXT NOT NULL,
          likes_count INTEGER DEFAULT 0,
          downvotes_count INTEGER DEFAULT 0,
          reposts_count INTEGER DEFAULT 0,
          replies_count INTEGER DEFAULT 0,
          saves_count INTEGER DEFAULT 0,
          views_count INTEGER DEFAULT 0,
          impressions_count INTEGER DEFAULT 0,
          is_liked INTEGER DEFAULT 0,
          is_downvoted INTEGER DEFAULT 0,
          is_reposted INTEGER DEFAULT 0,
          is_saved INTEGER DEFAULT 0,
          is_owner INTEGER DEFAULT 0,
          visibility TEXT DEFAULT 'public',
          created_at TEXT NOT NULL,
          updated_at TEXT,
          fetched_at INTEGER NOT NULL,
          raw_json TEXT,
          FOREIGN KEY (user_id) REFERENCES actors(id)
        )
      `);

      // Feed items — join table linking feeds to posts with ordering
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

      // Feed metadata — cursor, hasMore, etc. per feed
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

      // Link preview cache
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

      // Indices
      db.execSync('CREATE INDEX IF NOT EXISTS idx_actors_username ON actors(username)');
      db.execSync('CREATE INDEX IF NOT EXISTS idx_posts_user_id ON posts(user_id)');
      db.execSync('CREATE INDEX IF NOT EXISTS idx_posts_parent ON posts(parent_post_id) WHERE parent_post_id IS NOT NULL');
      db.execSync('CREATE INDEX IF NOT EXISTS idx_posts_original ON posts(original_post_id) WHERE original_post_id IS NOT NULL');
      db.execSync('CREATE INDEX IF NOT EXISTS idx_posts_created ON posts(created_at DESC)');
      db.execSync('CREATE INDEX IF NOT EXISTS idx_posts_saved ON posts(is_saved) WHERE is_saved = 1');
      db.execSync('CREATE INDEX IF NOT EXISTS idx_posts_fetched ON posts(fetched_at)');
      db.execSync('CREATE INDEX IF NOT EXISTS idx_feed_items_position ON feed_items(feed_key, position)');
      db.execSync('CREATE INDEX IF NOT EXISTS idx_feed_items_post_id ON feed_items(post_id)');
      db.execSync('CREATE INDEX IF NOT EXISTS idx_link_previews_expiry ON link_previews(fetched_at)');
    },
  },
];

/**
 * Run all pending migrations in order.
 */
export function runMigrations(db: SQLite.SQLiteDatabase): void {
  // Ensure schema_version table exists
  db.execSync(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    )
  `);

  // Get current version
  const row = db.getFirstSync<{ version: number }>(
    'SELECT MAX(version) as version FROM schema_version'
  );
  const currentVersion = row?.version ?? 0;

  // Apply pending migrations
  const pending = migrations.filter((m) => m.version > currentVersion);
  if (pending.length === 0) {
    logger.debug(`Database up to date at v${currentVersion}`);
    return;
  }

  logger.debug(`Running ${pending.length} migration(s) from v${currentVersion}...`);

  for (const migration of pending) {
    try {
      db.execSync('BEGIN TRANSACTION');
      migration.up(db);
      db.runSync(
        'INSERT INTO schema_version (version, applied_at) VALUES (?, ?)',
        migration.version,
        Date.now()
      );
      db.execSync('COMMIT');
      logger.debug(`Migration v${migration.version}: ${migration.description}`);
    } catch (error) {
      db.execSync('ROLLBACK');
      logger.error(`Migration v${migration.version} failed`, { error });
      throw error;
    }
  }

  logger.debug(`Migrations complete — now at v${pending[pending.length - 1].version}`);
}
