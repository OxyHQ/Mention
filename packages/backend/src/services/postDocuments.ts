import type { PostDocumentsResponse } from '@mention/shared-types';
import { loadPostRecords } from '../db/posts/postRepository';
import { postHydrationService, type HydrationOptions } from './PostHydrationService';

/**
 * The link cards of posts whose first read reported `documentsPending`.
 *
 * The posts go through the same hydration as `GET /posts/:id`, so this answers
 * for exactly the posts this viewer may read, in the language variant they are
 * served; a post they may not read, or that is gone, is simply absent. Only the
 * cards are returned; the app already has the rest of each post.
 *
 * It answers with what Clarity has NOW and never holds the call open for the
 * rest: a card still pending comes back `documentsPending`, and the app asks
 * again on its own backoff (`stores/pendingDocuments.ts`). Holding it open for
 * Clarity (a 3 s wait) made the call's p50 3,078 ms in production — nearly every
 * follow-up waited the whole window — for cards the app's retry gets anyway.
 */
export async function loadPendingPostDocuments(
  ids: readonly string[],
  viewer: Pick<
    HydrationOptions,
    | 'safetyRequester'
    | 'viewerId'
    | 'oxyClient'
    | 'viewerPrivacy'
    | 'viewerGraph'
    | 'requestLanguages'
    | 'operatedAccountReader'
  >,
): Promise<PostDocumentsResponse> {
  const records = await loadPostRecords(ids);
  if (records.length === 0) return { posts: {} };

  const hydrated = await postHydrationService.hydratePosts(records, {
    ...viewer,
    maxDepth: 0,
    includeLinkMetadata: true,
  });

  const requested = new Set(ids);
  // Built from entries rather than by assigning `posts[id]`: an id is data from
  // the database, and assignment would treat an id like `__proto__` as the
  // object's prototype instead of a key.
  return {
    posts: Object.fromEntries(
      hydrated
        .filter((post) => requested.has(post.id))
        .map((post) => [
          post.id,
          {
            documents: post.documents ?? [],
            ...(post.documentsPending ? { documentsPending: true } : {}),
          },
        ]),
    ),
  };
}
