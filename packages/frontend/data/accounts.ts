import { type Store, withStore } from '@oxy.so/bloom-data';
import { Feed, feedKey } from './feeds';

/**
 * The data store of the signed-in account is the Oxy session's
 * (`@oxy.so/bloom-data`): OxyProvider opens one store per account, the
 * signed-out viewer (`anon`) included, and opens the next account's on a
 * switch before anything is woken. The store's file is `accountPersister`
 * (`data/persister`), handed to OxyProvider as its `dataPersister`.
 */

/** The feed the app opens on. */
const HOME_FEED = feedKey({ type: 'for_you' });

/**
 * Boot step: the one synchronous read. When an account's store opens, the
 * home feed's disk copy (its ids, its posts and the posts they embed) is read
 * now, before the tree mounts, so a cold start paints the last session's feed
 * on its first frame. Asynchronous reads at startup wait on a JS thread that
 * stalls for hundreds of milliseconds (measured on a Pixel 8a: the first post
 * came after the network page, ~5 s later than the synchronous read it
 * replaces). `AccountSwitchReset` calls it once per store, never during
 * render; web has no copy to read.
 */
export function bootAccountData(store: Store): void {
  withStore(store, () => Feed.loadNow(HOME_FEED));
}
