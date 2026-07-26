/**
 * Browser persistence boundary.
 *
 * SQLite remains the native offline cache. The web app deliberately operates
 * in network-only mode so expo-sqlite/WASM and SharedArrayBuffer requirements
 * are excluded from its initial bundle.
 */
export interface SQLiteDb {
  execSync(sql: string): void;
  runSync(
    sql: string,
    ...params: unknown[]
  ): { changes: number; lastInsertRowId: number };
  getFirstSync<T>(sql: string, ...params: unknown[]): T | null;
  getAllSync<T>(sql: string, ...params: unknown[]): T[];
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
