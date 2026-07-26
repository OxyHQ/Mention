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
 * A post-shaped record carrying actors from the canonical hydration contract.
 * The input remains runtime-defensive because this function sits at an API/cache
 * ingestion boundary, but it does not accept alternate identity or relation
 * field names.
 */
interface PostWithActors {
  user?: CacheableUser;
  originalPost?: { user?: CacheableUser } | null;
  quotedPost?: { user?: CacheableUser } | null;
  boost?: {
    actor?: CacheableUser;
    originalPost?: { user?: CacheableUser } | null;
  } | null;
}

/**
 * Extract every embedded actor from a batch of posts and prime React Query.
 * Extract the post author, the one embedded related-post author, and the boost
 * actor. Hydration may expose the same related post through `originalPost` and
 * the more specific quote/boost field, so precedence avoids duplicate upserts.
 */
export function precacheActorsFromPosts(
  posts: readonly unknown[] | null | undefined,
): void {
  if (!Array.isArray(posts) || posts.length === 0) return;

  const users: CacheableUser[] = [];
  for (const raw of posts) {
    if (!raw || typeof raw !== 'object') continue;
    const p = raw as PostWithActors;
    if (p.user?.id) users.push(p.user);
    const relatedPost =
      p.boost?.originalPost ?? p.quotedPost ?? p.originalPost;
    if (relatedPost?.user) users.push(relatedPost.user);
    if (p.boost?.actor) users.push(p.boost.actor);
  }

  if (users.length > 0) {
    upsertCachedUsers(queryClient, users);
  }
}
