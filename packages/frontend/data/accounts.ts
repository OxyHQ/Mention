import { createAccounts, type Store, withStore } from '@oxy.so/bloom-data';
import { Feed, feedKey } from './feeds';
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

/** The feed the app opens on: its disk copy is read at boot, not when it mounts. */
const HOME_FEED = feedKey({ type: 'for_you' });

/** Opens (or keeps) the store of `viewerCacheId`, the signed-in account or `anon`. */
export function openAccountData(viewerCacheId: string): Store {
  const opened = accounts.store;
  const store = accounts.open(viewerCacheId);
  // A cold start paints the last session's home feed: read it from disk now,
  // while the app shell mounts, so the feed finds it in memory.
  if (store !== opened) withStore(store, () => void Feed.load(HOME_FEED));
  return store;
}
