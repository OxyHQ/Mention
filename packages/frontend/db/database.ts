/**
 * Database initialization and singleton management
 * 
 * Uses expo-sqlite with JSI for synchronous access on the JS thread.
 * Configures WAL mode, foreign keys, and optimal cache settings.
 * 
 * On web: expo-sqlite requires SharedArrayBuffer (COOP/COEP headers).
 * If unavailable, all queries gracefully return empty results and
 * the app falls back to pure network fetches.
 */

import { Platform } from 'react-native';
import { createScopedLogger } from '@/lib/logger';

const logger = createScopedLogger('Database');

const DB_NAME = 'mention.db';

/**
 * Minimal type for the SQLite database interface.
 * Avoids importing expo-sqlite at module level (would crash on web).
 */
export interface SQLiteDb {
  execSync(sql: string): void;
  runSync(sql: string, ...params: any[]): { changes: number; lastInsertRowId: number };
  getFirstSync<T>(sql: string, ...params: any[]): T | null;
  getAllSync<T>(sql: string, ...params: any[]): T[];
  closeSync(): void;
}

// Lazy-loaded SQLite module — only imported on native or when web supports it
let SQLiteModule: typeof import('expo-sqlite') | null = null;
let db: SQLiteDb | null = null;
let initialized = false;
let _isAvailable: boolean | null = null;

/**
 * Check if SQLite is available on this platform.
 * On native (iOS/Android): always true.
 * On web: true only if SharedArrayBuffer is available (requires COOP/COEP headers).
 */
export function isDbAvailable(): boolean {
  if (_isAvailable !== null) return _isAvailable;

  if (Platform.OS !== 'web') {
    _isAvailable = true;
    return true;
  }

  // Web: check for SharedArrayBuffer support
  _isAvailable = typeof SharedArrayBuffer !== 'undefined';
  if (!_isAvailable) {
    logger.debug('SQLite unavailable on web (SharedArrayBuffer not supported) — using network-only mode');
  }
  return _isAvailable;
}

/**
 * Get the singleton database instance.
 * Returns null if SQLite is not available (web without COOP/COEP).
 * Initializes on first call with PRAGMA settings and migrations.
 */
export function getDb(): SQLiteDb | null {
  if (!isDbAvailable()) return null;
  if (db && initialized) return db;

  try {
    if (!SQLiteModule) {
      SQLiteModule = require('expo-sqlite');
    }

    if (!db) {
      db = SQLiteModule!.openDatabaseSync(DB_NAME);
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
      const { runMigrations } = require('./migrations');
      runMigrations(db);

      initialized = true;
      logger.debug('Database initialized with PRAGMA settings and migrations');
    }

    return db;
  } catch (e) {
    logger.error('Failed to initialize SQLite', { error: e });
    _isAvailable = false;
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
  if (!isDbAvailable()) return;
  closeDb();
  try {
    if (!SQLiteModule) SQLiteModule = require('expo-sqlite');
    SQLiteModule!.deleteDatabaseSync(DB_NAME);
    logger.debug('Database deleted');
  } catch (e) {
    logger.error('Error deleting database', { error: e });
  }
  // Re-initialize on next getDb() call
}
