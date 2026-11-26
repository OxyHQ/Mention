/**
 * Reactive user-cache reads backed by the SDK's `User` (Services 15: one
 * `@oxy.so/bloom-data` store per account, the account's actor cache). These
 * adapters return the cached `User` directly — matching the prior selector
 * shape — so call sites read `user?.username` etc. unchanged.
 */

import { useEntity } from '@oxy.so/bloom-data';
import { User as UserRecord, useUserById as useSdkUserById } from '@oxy.so/services/ui/client';
import type { User } from '@oxy.so/core';

/** Reactively read a user by id, fetching it when it is not held. */
export function useUserById(id?: string): User | undefined {
  const { value } = useSdkUserById(id ?? null, { enabled: Boolean(id) });
  return value ?? undefined;
}

/**
 * The cached user for an id, read and subscribed to WITHOUT fetching.
 *
 * For list rows whose payload already carries what they draw (a recommendation
 * has the username, avatar and colour). {@link useUserById} would refetch every
 * row it does not hold — five requests for a five-person rail. This still picks
 * up anything written to the record later (a batched avatar enrichment),
 * because it subscribes to the same record.
 */
export function useCachedUserSnapshot(id?: string): User | undefined {
  return useEntity(UserRecord, id || undefined) as User | undefined;
}
