/**
 * Singleton QueryClient — the single in-memory cache for the whole app.
 *
 * Exported as a module-level instance so non-React code (feed/post ingestion,
 * imperative cache priming) can read and write the same cache the app's React
 * Query hooks consume. Services 15 holds no React Query cache of its own, so
 * `components/providers/AppProviders.tsx` mounts this one in a
 * `QueryClientProvider` above `OxyProvider`.
 *
 * It is the signed-in account's (`lib/accountScope.ts`): every query is
 * dropped on an account change, and every mutation is bound to the account it
 * started for. A mutation whose account is left runs none of its own
 * `onMutate`, `onSuccess`, `onError` or `onSettled` from then on, so neither
 * its optimistic paint, its answer nor its rollback reaches the next
 * account's cache, and its request is not sent at all if it had not left yet
 * (`AccountChangedError`). (Syra's and Inbox's clients keep
 * that hole open: their old account's mutation could still `setQueryData`
 * into the new one.)
 */

import {
  MutationCache,
  type MutationFunctionContext,
  type MutationOptions,
  QueryClient,
  type QueryKey,
  type SetDataOptions,
  type Updater,
} from '@tanstack/react-query';
import { QUERY_CLIENT_CONFIG } from '@/components/providers/constants';
import { type AccountToken, captureAccount } from '@/lib/accountScope';

/**
 * The account each running mutation started for, keyed by the context React
 * Query creates for one execution and passes to its `onMutate`, `onSuccess`,
 * `onError` and `onSettled` (the same object every time).
 */
const startedFor = new WeakMap<object, AccountToken>();
const guarded = new WeakSet<object>();

type Callback = (...args: never[]) => unknown;

/** `callback`, skipped once the account its execution started for is left. */
function bindToAccount<T extends Callback | undefined>(callback: T, contextIndex: number): T {
  if (!callback || guarded.has(callback)) return callback;
  const bound = ((...args: unknown[]) => {
    const context = args[contextIndex];
    const token = typeof context === 'object' && context ? startedFor.get(context) : undefined;
    if (token && !token.isCurrent()) return undefined;
    return (callback as (...a: unknown[]) => unknown)(...args);
  }) as unknown as T;
  guarded.add(bound as object);
  return bound;
}

/** Raised by a mutation whose account was left before its request was sent. */
export class AccountChangedError extends Error {
  constructor() {
    super('The account changed before this write was sent');
    this.name = 'AccountChangedError';
  }
}

/**
 * `mutationFn`, refused once the account its execution started for is left:
 * React Query awaits the `onMutate`s before it calls it, so a switch in
 * between would otherwise send the previous account's write with the next
 * account's session.
 */
function refuseOnceLeft<T extends Callback | undefined>(mutationFn: T): T {
  if (!mutationFn || guarded.has(mutationFn)) return mutationFn;
  const bound = ((...args: unknown[]) => {
    const context = args[1];
    const token = typeof context === 'object' && context ? startedFor.get(context) : undefined;
    if (token && !token.isCurrent()) return Promise.reject(new AccountChangedError());
    return (mutationFn as (...a: unknown[]) => unknown)(...args);
  }) as unknown as T;
  guarded.add(bound as object);
  return bound;
}

// biome-ignore lint/suspicious/noExplicitAny: React Query's own option generics.
type AnyMutationOptions = MutationOptions<any, any, any, any>;

/** Mention's QueryClient: React Query's, with every mutation bound to its account. */
export class AccountQueryClient extends QueryClient {
  constructor() {
    super({
      ...QUERY_CLIENT_CONFIG,
      mutationCache: new MutationCache({
        // Runs first in every execution, before the mutation's own `onMutate`.
        onMutate: (_variables, _mutation, context: MutationFunctionContext) => {
          startedFor.set(context, captureAccount());
        },
      }),
    });
  }

  /**
   * Every mutation's options pass through here (its observer, `build`), and
   * an observer re-applies them on every render: wrapping here is what keeps
   * the guard on the options a pending mutation ends up running.
   */
  override defaultMutationOptions<T extends AnyMutationOptions>(options?: T): T {
    const defaulted = super.defaultMutationOptions(options);
    if (!defaulted) return defaulted;
    defaulted.mutationFn = refuseOnceLeft(defaulted.mutationFn);
    defaulted.onMutate = bindToAccount(defaulted.onMutate, 1);
    defaulted.onSuccess = bindToAccount(defaulted.onSuccess, 3);
    defaulted.onError = bindToAccount(defaulted.onError, 3);
    defaulted.onSettled = bindToAccount(defaulted.onSettled, 4);
    return defaulted;
  }
}

export const queryClient: QueryClient = new AccountQueryClient();

/** Writes into the cache for the account captured when it was made. */
export interface AccountCacheWriter {
  readonly token: AccountToken;
  setQueryData<T>(
    queryKey: QueryKey,
    updater: Updater<T | undefined, T | undefined>,
    options?: SetDataOptions,
  ): void;
  /** Runs `write` only while the captured account is still the signed-in one. */
  run(write: (client: QueryClient) => void): void;
}

/**
 * A writer bound to the signed-in account now. Take it BEFORE an `await` and
 * write the answer through it after: once the account changed it writes
 * nothing, so a late answer never lands in the next account's cache.
 */
export function accountCacheWriter(client: QueryClient = queryClient): AccountCacheWriter {
  const token = captureAccount();
  return {
    token,
    setQueryData(queryKey, updater, options) {
      if (token.isCurrent()) client.setQueryData(queryKey, updater, options);
    },
    run(write) {
      if (token.isCurrent()) write(client);
    },
  };
}
