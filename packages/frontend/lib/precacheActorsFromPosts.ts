/**
 * Prime the React Query actor cache from feed/post ingestion.
 *
 * Replaces the former SQLite user-priming pass (which wrote embedded post
 * authors into a local table — a silent no-op on web). Now it merge-upserts those
 * user objects into the shared React Query cache via the SDK's
 * `upsertCachedUsers`, so avatars and names populate on web (and native) the
 * moment a feed response arrives — WITHOUT a sparse feed author clobbering the
 * `createdAt`, viewer `relationship`, or `_count` an authoritative profile fetch
 * already stored.
 */

import { upsertCachedUsers, type CacheableUser } from '@oxyhq/services';
import { queryClient } from '@/lib/queryClient';

/**
 * A post-shaped record carrying embedded actor objects. Intentionally loose —
 * feed responses, hydrated posts, and transformed UI items all satisfy it — so
 * we read the actor fields defensively rather than coupling to one post type.
 */
interface PostWithActors {
  user?: CacheableUser;
  original?: { user?: CacheableUser } | null;
  quoted?: { user?: CacheableUser } | null;
  boostedBy?: CacheableUser;
  boost?: { actor?: CacheableUser } | null;
}

/**
 * Extract every embedded actor from a batch of posts and prime React Query.
 * Mirrors the original SQLite priming surface: post author, original/quoted
 * authors, booster, and boost actor.
 */
export function precacheActorsFromPosts(
  posts: readonly unknown[] | null | undefined,
): void {
  if (!Array.isArray(posts) || posts.length === 0) return;

  const users: CacheableUser[] = [];
  for (const raw of posts) {
    if (!raw || typeof raw !== 'object') continue;
    const p = raw as PostWithActors;
    if (p.user && (p.user.id || p.user._id)) users.push(p.user);
    if (p.original?.user) users.push(p.original.user);
    if (p.quoted?.user) users.push(p.quoted.user);
    if (p.boostedBy) users.push(p.boostedBy);
    if (p.boost?.actor) users.push(p.boost.actor);
  }

  if (users.length > 0) {
    upsertCachedUsers(queryClient, users);
  }
}
