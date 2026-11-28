/**
 * Reactive user-cache reads backed by React Query (the single in-memory actor
 * cache). These adapters return the cached `User` directly — matching the prior
 * selector shape — so call sites read `user?.username` etc. unchanged while the
 * underlying cache is now React Query, which works on web (no SQLite /
 * SharedArrayBuffer required) and native alike.
 */

import { skipToken, useQuery } from '@tanstack/react-query';
import { queryKeys, useUserById as useSdkUserById } from '@oxy.so/services/ui/client';
import type { User } from '@oxy.so/core';

/** Reactively read a cached user by id. Subscribes to the React Query cache. */
export function useUserById(id?: string): User | undefined {
  const { data } = useSdkUserById(id ?? null, { enabled: Boolean(id) });
  return data ?? undefined;
}

/**
 * The cached user for an id, read and subscribed to WITHOUT fetching.
 *
 * For list rows whose payload already carries what they draw (a recommendation
 * has the username, avatar and colour). {@link useUserById} would refetch every
 * row: the actor cache seeds a cold entry stale on purpose, so a row mounting on
 * it asks Oxy for that person again — five requests for a five-person rail. This
 * still picks up anything written to the entry later (a batched avatar
 * enrichment), because it subscribes to the same key.
 */
export function useCachedUserSnapshot(id?: string): User | undefined {
  const { data } = useQuery<User>({
    queryKey: queryKeys.users.detail(id ?? ''),
    queryFn: skipToken,
  });
  return data;
}
