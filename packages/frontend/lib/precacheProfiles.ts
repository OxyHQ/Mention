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
 * The by-username key uses the RAW `username`, exactly as the SDK hook builds it
 * (`username || ''`) — it does NOT lowercase — so seed and read never diverge.
 *
 * The by-username entry alone carries the viewer-relative `relationship`
 * (`followsYou`), fetched by the authenticated single-profile call. Feed/list
 * users never carry it, so priming must never DOWNGRADE a relationship-bearing
 * entry to a relationship-less one (that is the "Follows you tag vanishes when
 * the feed loads" bug): a seed only fills an empty/relationship-less slot.
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
  // Viewer-relative follow relationship. Present ONLY on an authenticated
  // single-profile fetch (`getProfileByUsername`); `null` for anon/self/bulk and
  // absent on feed/list users. `followsYou` drives the profile "Follows you" tag.
  relationship?: { isFollowing?: boolean; followsYou?: boolean } | null;
  [key: string]: unknown;
}

/** Normalize a user-shaped object to a cache entry with a guaranteed string id. */
function withId(user: CacheableUser): (CacheableUser & { id: string }) | null {
  const id = String(user.id ?? user._id ?? '');
  if (!id) return null;
  return { ...user, id };
}

/**
 * Whether a cache entry already carries a viewer relationship — i.e. it came
 * from an authenticated single-profile fetch, not a list/feed/bulk response.
 * Used to avoid overwriting such an entry with a relationship-less one.
 */
function hasViewerRelationship(user: CacheableUser | undefined): boolean {
  return user?.relationship != null;
}

/**
 * Prime the React Query cache for a single user under both its id key and,
 * when a username is present, its username key.
 */
export function precacheProfileView(qc: QueryClient, user: CacheableUser): void {
  const normalized = withId(user);
  if (!normalized) return;

  // By-id identity entry — read by cards via `useUserById`. Its key is NOT
  // viewer-scoped (the SDK hook keys on `queryKeys.users.detail(id)` alone), so
  // it never carries a viewer `relationship`; kept FRESH so those reads are
  // satisfied instantly without a refetch.
  qc.setQueryData(queryKeys.users.detail(normalized.id), normalized);

  const username = normalized.username;
  if (username) {
    // The by-username entry is what the profile page reads via
    // `useUserByUsername` (`hooks/useProfileData`), whose key is viewer-scoped
    // because an authenticated single-profile fetch embeds the viewer-relative
    // `relationship` (`followsYou`). Build the SAME key the SDK hook reads: the
    // RAW `username` (the hook does not lowercase) and the active viewer id read
    // imperatively — `useAuthStore` is the same store behind the hook's
    // `useOxy().user?.id`, so the two stay in lockstep.
    const viewerId = useAuthStore.getState().user?.id ?? '';
    const usernameKey = [...queryKeys.users.details(), 'username', username, 'viewer', viewerId];

    // NEVER downgrade a relationship-bearing entry. If the profile page already
    // loaded this profile, its entry carries `relationship`; a feed/list user
    // does not, so overwriting would strip "Follows you" (and marking it stale
    // would force a needless refetch). Leave it untouched. Only when nothing
    // relationship-bearing is cached do we seed identity — STALE (`updatedAt: 0`)
    // so react-query still refetches to pull the viewer's `relationship`.
    if (!hasViewerRelationship(qc.getQueryData<CacheableUser>(usernameKey))) {
      qc.setQueryData(usernameKey, normalized, { updatedAt: 0 });
    }
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
