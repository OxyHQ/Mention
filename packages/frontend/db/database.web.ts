/**
 * Browser persistence boundary.
 *
 * SQLite remains the native offline cache. The web app deliberately operates
 * in network-only mode so expo-sqlite/WASM and SharedArrayBuffer requirements
 * are excluded from its initial bundle.
 */
// Type-only, so expo-sqlite stays out of the web bundle while both platform
// contracts still describe the SAME bind-parameter surface — `database.ts`
// re-exports this file for tsc, so a native call site is only ever checked
// against what is written here.
import type { SQLiteBindValue } from 'expo-sqlite';

export interface SQLiteDb {
  execSync(sql: string): void;
  runSync(
    sql: string,
    ...params: SQLiteBindValue[]
  ): { changes: number; lastInsertRowId: number };
  getFirstSync<T>(sql: string, ...params: SQLiteBindValue[]): T | null;
  getAllSync<T>(sql: string, ...params: SQLiteBindValue[]): T[];
  closeSync(): void;
}

export function isDbAvailable(): boolean {
  return false;
}

export function getDb(): SQLiteDb | null {
  return null;
}

export function closeDb(): void {
  // Network-only on web.
}

export function resetDb(): void {
  // Network-only on web.
}
