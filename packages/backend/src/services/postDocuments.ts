import type { PostDocumentsResponse } from '@mention/shared-types';
import { loadPostRecords } from '../db/posts/postRepository';
import { postHydrationService, type HydrationOptions } from './PostHydrationService';

/**
 * How long a follow-up may hold Clarity open for links it is still indexing.
 * These reads are off the render path — the post is already on screen without
 * its card — so waiting here costs the reader nothing, unlike on a feed read
 * (issue #1140).
 */
const FOLLOW_UP_WAIT_MS = 3_000;

/**
 * The link cards of posts whose first read reported `documentsPending`.
 *
 * The posts go through the same hydration as `GET /posts/:id`, so this answers
 * for exactly the posts this viewer may read, in the language variant they are
 * served; a post they may not read, or that is gone, is simply absent. Only the
 * cards are returned; the app already has the rest of each post.
 */
export async function loadPendingPostDocuments(
  ids: readonly string[],
  viewer: Pick<HydrationOptions, 'viewerId' | 'oxyClient' | 'viewerPrivacy' | 'viewerGraph' | 'requestLanguages'>,
): Promise<PostDocumentsResponse> {
  const response: PostDocumentsResponse = { posts: {} };
  const records = await loadPostRecords(ids);
  if (records.length === 0) return response;

  const hydrated = await postHydrationService.hydratePosts(records, {
    ...viewer,
    maxDepth: 0,
    includeLinkMetadata: true,
    linkMetadataWaitMs: FOLLOW_UP_WAIT_MS,
  });

  const requested = new Set(ids);
  for (const post of hydrated) {
    if (!requested.has(post.id)) continue;
    response.posts[post.id] = {
      documents: post.documents ?? [],
      ...(post.documentsPending ? { documentsPending: true } : {}),
    };
  }
  return response;
}
