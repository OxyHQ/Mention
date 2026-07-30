/**
 * Database initialization and singleton management
 *
 * Uses expo-sqlite with JSI for synchronous access on the JS thread.
 * Configures WAL mode, foreign keys, and optimal cache settings.
 *
 * Native-only implementation. Web intentionally uses a network-only stub so
 * expo-sqlite and its WASM runtime never enter the browser dependency graph.
 */

import * as SQLite from 'expo-sqlite';
import { createLogger } from '@oxyhq/core/logger';
import { runMigrations } from './migrations';

const logger = createLogger('Database');

const DB_NAME = 'mention.db';

/** Minimal database surface used by the cache layer. */
export interface SQLiteDb {
  execSync(sql: string): void;
  runSync(sql: string, ...params: SQLite.SQLiteBindValue[]): { changes: number; lastInsertRowId: number };
  getFirstSync<T>(sql: string, ...params: SQLite.SQLiteBindValue[]): T | null;
  getAllSync<T>(sql: string, ...params: SQLite.SQLiteBindValue[]): T[];
  closeSync(): void;
}

let db: SQLite.SQLiteDatabase | null = null;
let initialized = false;
let sqliteAvailable = true;

/**
 * Native builds include SQLite. A failed initialization marks it unavailable
 * for the rest of the process so cache callers degrade without repeated work.
 */
export function isDbAvailable(): boolean {
  return sqliteAvailable;
}

/**
 * Get the singleton database instance.
 * Returns null after a native SQLite initialization failure.
 * Initializes on first call with PRAGMA settings and migrations.
 */
export function getDb(): SQLiteDb | null {
  if (!isDbAvailable()) return null;
  if (db && initialized) return db;

  try {
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
  } catch (e) {
    logger.error('Failed to initialize SQLite', e);
    sqliteAvailable = false;
    db = null;
    initialized = false;
    return null;
  }
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
      logger.error('Error closing database', e);
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
  if (!isDbAvailable()) return;
  closeDb();
  try {
    SQLite.deleteDatabaseSync(DB_NAME);
    logger.debug('Database deleted');
  } catch (e) {
    logger.error('Error deleting database', e);
  }
  // Re-initialize on next getDb() call
}
