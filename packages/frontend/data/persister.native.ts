import type { Persister } from '@oxy.so/bloom-data';
import { sqlitePersister } from '@oxy.so/bloom-data/sqlite';
import * as SQLite from 'expo-sqlite';

/**
 * One SQLite file per account (`mention-data-<account>.db`), opened with the
 * asynchronous API only: rows are written in the background and read when a
 * screen opens, never while React renders. A switch never needs a wipe, and
 * one account's rows can never be read as another's.
 */
export function accountPersister(account: string): Persister {
  const name = `mention-data-${account.replace(/[^A-Za-z0-9_-]/g, '_')}.db`;
  return sqlitePersister(() => SQLite.openDatabaseAsync(name));
}
