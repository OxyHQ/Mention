/**
 * Node's built-in SQLite (`node:sqlite`) behind the synchronous expo-sqlite
 * calls `mention.db`'s code makes, so its SQL runs for real in tests.
 */
interface NodeDatabase {
  exec(source: string): void;
  prepare(source: string): {
    all(...params: unknown[]): unknown[];
    get(...params: unknown[]): unknown;
    run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  };
}

export function openNodeSqlite() {
  const { DatabaseSync } = require('node:sqlite') as {
    DatabaseSync: new (path: string) => NodeDatabase;
  };
  const db = new DatabaseSync(':memory:');
  const plain = <T>(row: unknown) => (row ? ({ ...(row as object) } as T) : null);
  return {
    execSync: (source: string) => db.exec(source),
    runSync: (source: string, ...params: unknown[]) => {
      const result = db.prepare(source).run(...params);
      return { changes: Number(result.changes), lastInsertRowId: Number(result.lastInsertRowid) };
    },
    getFirstSync: <T>(source: string, ...params: unknown[]) =>
      plain<T>(db.prepare(source).get(...params)),
    getAllSync: <T>(source: string, ...params: unknown[]) =>
      db
        .prepare(source)
        .all(...params)
        .map((row) => plain<T>(row) as T),
    tables: () =>
      (
        db
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
          .all() as Array<{ name: string }>
      ).map((row) => row.name),
  };
}
