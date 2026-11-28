import { setActiveStore, Store } from '@oxy.so/bloom-data';
import { followSessionRuntime } from '@/lib/accountScope';

/**
 * Stands in for the Services session runtime that `lib/accountScope` follows, for
 * tests that ask who is signed in outside a render.
 *
 *   beforeEach(() => signInAs('viewer-1'));
 *   afterEach(signOutForTests);
 */

let accountId: string | null = null;
let unfollow: (() => void) | undefined;
const listeners = new Set<() => void>();

const runtime = {
  getSnapshot: () => ({ account: accountId ? { id: accountId } : null }),
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};

/** Make `next` the signed-in account (`null` signs out), notifying as the runtime does. */
export function signInAs(next: string | null): void {
  accountId = next;
  if (!unfollow) {
    unfollow = followSessionRuntime(runtime);
    return;
  }
  for (const listener of [...listeners]) listener();
}

/** A new, empty bloom-data store made active: the signed-in account's `User` and records. */
export function openAccountStore(): Store {
  const store = new Store();
  setActiveStore(store);
  return store;
}

/** Back to signed out, unfollowed, with no active store (`afterEach`). */
export function signOutForTests(): void {
  accountId = null;
  unfollow?.();
  unfollow = undefined;
  setActiveStore(undefined);
}
