import { setActiveStore, Store } from '@oxy.so/bloom-data';
import { QueryClient } from '@tanstack/react-query';
import { activateAccount, resetAccountScopeForTests } from '@/lib/accountScope';

/**
 * Drive Mention's account scope (`lib/accountScope.ts`) the way the Services
 * runtime does, for tests that used to mock Services 14's `useAuthStore`.
 *
 *   beforeEach(() => signInAs('viewer-1'));
 *   afterEach(signOutForTests);
 *
 * A switch is `signInAs('viewer-2')`: it opens a new generation, so every token
 * captured before it (`captureAccount`, `actorWriter`, `accountCacheWriter`)
 * goes stale, exactly as on device.
 */

/** A client nobody renders with: what `activateAccount` drops when the test passes none. */
let scratchClient: QueryClient | undefined;

/**
 * Make `accountId` the signed-in account (`null` signs out). Pass the client
 * the test renders with to have its queries and mutations dropped by the
 * change, as the runtime's notification does on device.
 */
export function signInAs(accountId: string | null, queryClient?: QueryClient): void {
  scratchClient ??= new QueryClient();
  activateAccount(accountId, queryClient ?? scratchClient);
}

/** A new, empty bloom-data store made active: the signed-in account's `User` and records. */
export function openAccountStore(): Store {
  const store = new Store();
  setActiveStore(store);
  return store;
}

/** Back to signed out with no active store (`afterEach`). */
export function signOutForTests(): void {
  resetAccountScopeForTests();
  setActiveStore(undefined);
}
