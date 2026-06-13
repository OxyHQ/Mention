/**
 * Prime the React Query actor cache from feed/post ingestion.
 *
 * Replaces the former SQLite user-priming pass (which wrote embedded post
 * authors into a local table — a silent no-op on web). Now it writes those user
 * objects directly into the shared React Query cache via `precacheProfileViews`,
 * so avatars and names populate on web (and native) the moment a feed response
 * arrives.
 */

import { queryClient } from '@/lib/queryClient';
import { precacheProfileViews, type CacheableUser } from '@/lib/precacheProfiles';

/**
 * A post-shaped record carrying embedded actor objects. Intentionally loose —
 * feed responses, hydrated posts, and transformed UI items all satisfy it — so
 * we read the actor fields defensively rather than coupling to one post type.
 */
interface PostWithActors {
  user?: CacheableUser;
  original?: { user?: CacheableUser } | null;
  quoted?: { user?: CacheableUser } | null;
  repostedBy?: CacheableUser;
  repost?: { actor?: CacheableUser } | null;
}

/**
 * Extract every embedded actor from a batch of posts and prime React Query.
 * Mirrors the original SQLite priming surface: post author, original/quoted
 * authors, reposter, and repost actor.
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
    if (p.repostedBy) users.push(p.repostedBy);
    if (p.repost?.actor) users.push(p.repost.actor);
  }

  if (users.length > 0) {
    precacheProfileViews(queryClient, users);
  }
}
