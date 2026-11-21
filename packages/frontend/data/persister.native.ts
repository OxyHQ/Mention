import type { Persister } from '@oxy.so/bloom-data';
import { sqlitePersister } from '@oxy.so/bloom-data/sqlite';
import * as SQLite from 'expo-sqlite';

/**
 * One SQLite file per account (`mention-data-<account>.db`). Rows are written
 * in the background with the asynchronous API and read when a screen opens,
 * never while React renders.
 *
 * The file is opened with the synchronous API so the one boot read
 * (`data/accounts`: the home feed, before the app's tree mounts) can read it
 * without waiting on the JS thread; every later call uses the async API on
 * the same connection.
 */
export function accountPersister(account: string): Persister {
  const name = `mention-data-${account.replace(/[^A-Za-z0-9_-]/g, '_')}.db`;
  return sqlitePersister(() => SQLite.openDatabaseSync(name));
}
