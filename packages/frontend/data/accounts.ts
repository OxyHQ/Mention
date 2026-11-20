import { createAccounts, type Store } from '@oxy.so/bloom-data';
import { accountPersister } from './persister';

/**
 * The data store of the signed-in account (`@oxy.so/bloom-data`).
 *
 * `AccountSwitchReset` opens the resolved viewer's store before anything below
 * it mounts, and opens another on a switch. The previous account's queued
 * writes still reach its own file; anything that lands for it afterwards is
 * dropped. This replaces the single cache file that had to be claimed and
 * wiped on every switch (`claimViewerCache`) for posts and feeds.
 */
const accounts = createAccounts({ persister: accountPersister });

/** Opens (or keeps) the store of `viewerCacheId`, the signed-in account or `anon`. */
export function openAccountData(viewerCacheId: string): Store {
  return accounts.open(viewerCacheId);
}

/** Closes the open store (signed out with no viewer yet). */
export function closeAccountData(): Promise<void> {
  return accounts.close();
}
