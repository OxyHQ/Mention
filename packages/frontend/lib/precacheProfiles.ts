/**
 * Profile precaching helpers — the Bluesky `precacheProfile` pattern.
 *
 * Writes user objects into the React Query cache under the exact keys the SDK
 * hooks read from, so a list/search/feed response immediately satisfies later
 * `useUserById` / `useUserByUsername` reads without a network round-trip.
 *
 * Keys are sourced from the SDK's `queryKeys` — never hardcoded literals — so
 * they stay in lockstep with `useUserById` (`queryKeys.users.detail(id)`) and
 * `useUserByUsername`
 * (`[...queryKeys.users.details(), 'username', username, 'viewer', viewerId]`).
 */

import type { QueryClient } from '@tanstack/react-query';
import { queryKeys, useAuthStore } from '@oxyhq/services';

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

  // By-id identity entry (viewer-independent) — read by cards via `useUserById`.
  // Kept FRESH so those reads are satisfied instantly without a refetch.
  qc.setQueryData(queryKeys.users.detail(normalized.id), normalized);

  const username = normalized.username;
  if (username) {
    // The by-username entry is what the profile page reads via
    // `useUserByUsername`, whose key is viewer-scoped because an authenticated
    // single-profile fetch embeds the viewer-relative `relationship`
    // (`followsYou`). Seed under the SAME viewer-scoped key so navigating from a
    // list/feed still paints identity instantly — but mark it STALE (`updatedAt:
    // 0`) so react-query still refetches to pull the viewer's `relationship`.
    // Precached list/feed objects carry public identity only, never
    // `relationship`, so a fresh seed would suppress the fetch and the "Follows
    // you" tag would never appear. Reading the active viewer imperatively keeps
    // this in lockstep with `useUserByUsername`'s `useOxy().user?.id`.
    const viewerId = useAuthStore.getState().user?.id ?? '';
    qc.setQueryData(
      [...queryKeys.users.details(), 'username', username.toLowerCase(), 'viewer', viewerId],
      normalized,
      { updatedAt: 0 },
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
