/**
 * Reactive user-cache reads backed by React Query (the single in-memory actor
 * cache). These adapters return the cached `User` directly — matching the prior
 * selector shape — so call sites read `user?.username` etc. unchanged while the
 * underlying cache is now React Query, which works on web (no SQLite /
 * SharedArrayBuffer required) and native alike.
 */

import { useUserById as useSdkUserById } from '@oxyhq/services';
import type { User } from '@oxyhq/core';

/** Reactively read a cached user by id. Subscribes to the React Query cache. */
export function useUserById(id?: string): User | undefined {
  const { data } = useSdkUserById(id ?? null, { enabled: Boolean(id) });
  return data ?? undefined;
}
