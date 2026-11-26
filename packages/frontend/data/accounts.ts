import { createAccounts, type Store, withStore } from '@oxy.so/bloom-data';
import { Feed, feedKey } from './feeds';
import { accountPersister } from './persister';

/**
 * The data store of the signed-in account (`@oxy.so/bloom-data`).
 *
 * `AccountSwitchReset` opens the resolved viewer's store before anything below
 * it mounts, and opens another on a switch. The previous account's queued
 * writes still reach its own file; anything that lands for it afterwards is
 * dropped.
 */
const accounts = createAccounts({ persister: accountPersister });

/** The feed the app opens on. */
const HOME_FEED = feedKey({ type: 'for_you' });

/**
 * Opens (or keeps) the store of `viewerCacheId`, the signed-in account or `anon`.
 *
 * Boot step: the one synchronous read. When an account's store opens, the
 * home feed's disk copy (its ids, its posts and the posts they embed) is read
 * now, before the tree mounts, so a cold start paints the last session's feed
 * on its first frame. Asynchronous reads at startup wait on a JS thread that
 * stalls for hundreds of milliseconds (measured on a Pixel 8a: the first post
 * came after the network page, ~5 s later than the synchronous read it
 * replaces). It is never done during render; web has no copy to read.
 */
export function openAccountData(viewerCacheId: string): Store {
  const opened = accounts.store;
  const store = accounts.open(viewerCacheId);
  if (store !== opened) withStore(store, () => Feed.loadNow(HOME_FEED));
  return store;
}

/**
 * Deletes a signed-out account's posts and feeds from this device: closes its
 * store if it is the open one, then deletes its durable copy. For sign-out
 * only (Services does the same for its own records), so nothing of the
 * account stays behind; a switch keeps the account's copy for its return.
 */
export function forgetAccountData(viewerCacheId: string): Promise<void> {
  return accounts.forget(viewerCacheId);
}
