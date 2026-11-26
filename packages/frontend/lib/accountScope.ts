/**
 * The signed-in account Mention's in-memory caches belong to, followed from
 * the Services runtime.
 *
 * Services 14 kept `useAuthStore`, and Mention compared its `user.id` with
 * the account a piece of work started for before writing the answer. Services
 * 15 has no such store and holds no React Query cache: the session lives in
 * its runtime (`useOxyRuntime()`), which opens the next account's
 * `@oxy.so/bloom-data` store between committing the new bearer and waking
 * anybody. Mention's React Query cache is its own, so this does for it what
 * Inbox's and Syra's account caches do (`followOxyRuntime`):
 *
 * - On every subject change (switch, sign-in, sign-out) every query is removed
 *   and reset, synchronously, from the runtime's own notification, before
 *   React renders anything for the new account. A screen still subscribed to
 *   a removed query shows nothing of the account that was left, and the
 *   query's in-flight read is cancelled, so a late answer lands in a query
 *   nobody can reach. Every mutation record is dropped from the cache too.
 * - Each change opens a new generation. Work captures the generation it
 *   started in (`captureAccount()`) and writes its answer only while that
 *   generation is current, so a mutation, a fetch or an `await` that settles
 *   after a switch writes nothing into the next account's cache. The query
 *   client binds every mutation to its generation by itself
 *   (`lib/queryClient.ts`); code that writes after an `await` checks
 *   `isCurrent()` (or writes through `accountCacheWriter`).
 *
 * Mention's persisted data is not here: posts and feeds live in the account's
 * own bloom-data store (`data/accounts.ts`), opened by `AccountSwitchReset`,
 * and the link-preview cache is claimed per viewer (`db/cacheLifecycle.ts`).
 */

import { defaultScheduler, notifyManager, type QueryClient } from '@tanstack/react-query';

/** The runtime surface the scope follows (`useOxyRuntime()` from `@oxy.so/services/runtime`). */
export interface SubjectSource {
  getSnapshot(): { account: { id?: string | null } | null };
  subscribe(listener: () => void): () => void;
}

/** The account a piece of work started for. */
export interface AccountToken {
  /** The account id, `null` signed out. */
  readonly accountId: string | null;
  /** True while no account change happened since the token was taken. */
  isCurrent(): boolean;
}

let accountId: string | null = null;
let generation = 0;
const listeners = new Set<() => void>();

/** The signed-in account now (`null` signed out or before the runtime is followed). */
export function currentAccountId(): string | null {
  return accountId;
}

/** Called after every account change (Services 14's `useAuthStore.subscribe`). */
export function subscribeAccount(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The account now, for work that writes its answer later. */
export function captureAccount(): AccountToken {
  const started = generation;
  return {
    accountId,
    isCurrent: () => started === generation,
  };
}

/**
 * Remove every query, and reset each one removed: a removed query keeps its
 * data and its observers until they render again, so a screen that is not
 * re-rendered for the switch would go on showing it. The reset tells them, and
 * cancels the query's in-flight read. Their notifications run synchronously
 * (React Query schedules them on a `setTimeout` by default), so the screens
 * re-render in the same pass as the new account and no frame shows the old
 * one's data. Mention sets no scheduler of its own, so the default comes back.
 */
export function dropAccountQueries(queryClient: QueryClient): void {
  const cache = queryClient.getQueryCache();
  notifyManager.setScheduler((callback) => callback());
  try {
    notifyManager.batch(() => {
      for (const query of cache.getAll()) {
        cache.remove(query);
        query.reset();
      }
    });
  } finally {
    notifyManager.setScheduler(defaultScheduler);
  }
  queryClient.getMutationCache().clear();
}

/**
 * Make `next` the account. A change opens a new generation and drops the
 * previous account's queries and mutations before anybody is told.
 */
export function activateAccount(next: string | null, queryClient: QueryClient): void {
  if (next === accountId) return;
  generation += 1;
  dropAccountQueries(queryClient);
  accountId = next;
  for (const listener of [...listeners]) listener();
}

/**
 * Keep the scope on the runtime's subject: activated now, and again from the
 * runtime's notification on every change, synchronously, before any component
 * woken by it renders. Returns the disposer (the provider unmounting).
 */
export function followOxyRuntime(runtime: SubjectSource, queryClient: QueryClient): () => void {
  const sync = () => {
    const id = runtime.getSnapshot().account?.id?.trim();
    activateAccount(id ? id : null, queryClient);
  };
  const unsubscribe = runtime.subscribe(sync);
  sync();
  return unsubscribe;
}

/** Tests only: back to signed out, generation kept moving so old tokens stay stale. */
export function resetAccountScopeForTests(): void {
  generation += 1;
  accountId = null;
  listeners.clear();
}
