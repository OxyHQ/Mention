/**
 * Profile precaching helpers — the Bluesky `precacheProfile` pattern.
 *
 * Writes user objects into the React Query cache under the exact keys the SDK
 * hooks read from, so a list/search/feed response immediately satisfies later
 * `useUserById` / `useUserByUsername` reads without a network round-trip.
 *
 * Keys are sourced from the SDK's `queryKeys` — never hardcoded literals — so
 * they stay in lockstep with `useUserById` (`queryKeys.users.detail(id)`) and
 * `useUserByUsername` (`[...queryKeys.users.details(), 'username', username]`).
 */

import type { QueryClient } from '@tanstack/react-query';
import { queryKeys } from '@oxyhq/services';

/**
 * A user-shaped object that can be primed into the cache. Intentionally
 * permissive: it covers both the SDK `User` and the looser actor objects
 * embedded on posts/notifications/lists (where `name` may be a plain string and
 * the id may arrive as Mongo `_id`). Consumers already handle both `name`
 * shapes when reading.
 */
export interface CacheableUser {
  id?: string;
  _id?: string;
  username?: string;
  name?: string | { first?: string; last?: string; full?: string; [key: string]: unknown };
  // Mirrors the SDK `User.avatar` (`string | null`): the projected user whitelist
  // stores avatar as a nullable column, so `null` is a legitimate cache value.
  avatar?: string | null;
  [key: string]: unknown;
}

/** Normalize a user-shaped object to a cache entry with a guaranteed string id. */
function withId(user: CacheableUser): (CacheableUser & { id: string }) | null {
  const id = String(user.id ?? user._id ?? '');
  if (!id) return null;
  return { ...user, id };
}

/**
 * Prime the React Query cache for a single user under both its id key and,
 * when a username is present, its username key.
 */
export function precacheProfileView(qc: QueryClient, user: CacheableUser): void {
  const normalized = withId(user);
  if (!normalized) return;

  qc.setQueryData(queryKeys.users.detail(normalized.id), normalized);

  const username = normalized.username;
  if (username) {
    qc.setQueryData(
      [...queryKeys.users.details(), 'username', username.toLowerCase()],
      normalized,
    );
  }
}

/**
 * Prime the React Query cache for many users at once. Mirrors Bluesky's
 * `precacheProfile` applied across a list/search/feed response.
 */
export function precacheProfileViews(
  qc: QueryClient,
  users: readonly CacheableUser[] | null | undefined,
): void {
  if (!Array.isArray(users) || users.length === 0) return;
  for (const user of users) {
    if (user) precacheProfileView(qc, user);
  }
}
