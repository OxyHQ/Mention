/**
 * Database initialization and singleton management
 * 
 * Uses expo-sqlite with JSI for synchronous access on the JS thread.
 * Configures WAL mode, foreign keys, and optimal cache settings.
 */

import * as SQLite from 'expo-sqlite';
import { runMigrations } from './migrations';
import { createScopedLogger } from '@/lib/logger';

const logger = createScopedLogger('Database');

const DB_NAME = 'mention.db';

let db: SQLite.SQLiteDatabase | null = null;
let initialized = false;

/**
 * Get the singleton database instance.
 * Initializes on first call with PRAGMA settings and migrations.
 */
export function getDb(): SQLite.SQLiteDatabase {
  if (db && initialized) return db;

  if (!db) {
    db = SQLite.openDatabaseSync(DB_NAME);
    logger.debug('Database opened');
  }

  if (!initialized) {
    // WAL mode for concurrent reads during writes
    db.execSync('PRAGMA journal_mode = WAL');
    // Enable foreign key enforcement
    db.execSync('PRAGMA foreign_keys = ON');
    // NORMAL sync — safe with WAL, much faster than FULL
    db.execSync('PRAGMA synchronous = NORMAL');
    // 8MB page cache (negative = KiB)
    db.execSync('PRAGMA cache_size = -8000');
    // 64MB mmap for faster reads
    db.execSync('PRAGMA mmap_size = 67108864');
    // Smaller temporary store in memory
    db.execSync('PRAGMA temp_store = MEMORY');

    // Run schema migrations
    runMigrations(db);

    initialized = true;
    logger.debug('Database initialized with PRAGMA settings and migrations');
  }

  return db;
}

/**
 * Close the database connection.
 * Call on app shutdown or when resetting state.
 */
export function closeDb(): void {
  if (db) {
    try {
      db.closeSync();
    } catch (e) {
      logger.error('Error closing database', { error: e });
    }
    db = null;
    initialized = false;
    logger.debug('Database closed');
  }
}

/**
 * Reset the database — drops all data and re-runs migrations.
 * Use only for development or critical cache corruption recovery.
 */
export function resetDb(): void {
  closeDb();
  try {
    SQLite.deleteDatabaseSync(DB_NAME);
    logger.debug('Database deleted');
  } catch (e) {
    logger.error('Error deleting database', { error: e });
  }
  // Re-initialize on next getDb() call
}
