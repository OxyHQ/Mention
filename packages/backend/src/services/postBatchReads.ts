/**
 * Reads that answer for several posts at once: a post's ancestor chain and a
 * small batch by id.
 *
 * Both hydrate exactly as the single-post detail read (`GET /feed/item/:id`)
 * does, through the same `PostHydrationService` ACL, so they disclose nothing a
 * series of single reads would not — they only replace that series. A post the
 * viewer may not read is absent, as indistinguishable from a missing one as the
 * single read's 404 is.
 */

import { MAX_POST_ANCESTORS, type HydratedPost } from '@mention/shared-types';
import type { PostRecord } from '../db/posts/postRecord';
import { loadAncestorPostIds, loadPostRecords } from '../db/posts/postRepository';
import { callerOxyUser, createScopedOxyClient } from '../utils/oxyHelpers';
import { resolveViewerPrivacyAndGraph } from '../utils/privacyHelpers';
import { safetyRequesterFor, type RequestSafetyContext } from '../utils/safetyRequester';
import { getOrLoadPostRecords } from './postDetailCache';
import { postHydrationService } from './PostHydrationService';

/**
 * Hydrate `ids` for this request's viewer with the detail read's options, keyed
 * by id. A post hydration drops (or returns without an author) is absent.
 */
async function hydrateReadable(
  req: RequestSafetyContext,
  ids: readonly string[],
): Promise<Map<string, HydratedPost>> {
  const records: PostRecord[] = await getOrLoadPostRecords(ids, loadPostRecords);
  if (records.length === 0) return new Map();
  const oxyClient = createScopedOxyClient(req);
  const viewerContext = await resolveViewerPrivacyAndGraph(req.user?.id, oxyClient);
  const hydrated = await postHydrationService.hydratePosts(records, {
    viewerId: req.user?.id,
    safetyRequester: safetyRequesterFor(req),
    oxyClient,
    maxDepth: 0,
    includeLinkMetadata: true,
    includeFullArticleBody: false,
    includeFullMetadata: false,
    // The same shape the detail read caches, so a post first loaded through a
    // batch is not a poorer copy of one loaded alone.
    includeQuoteCounts: true,
    operatedAccountReader: callerOxyUser(req),
    viewerPrivacy: viewerContext?.viewerPrivacy,
    viewerGraph: viewerContext?.viewerGraph,
  });
  return new Map(
    hydrated
      .filter((post): post is HydratedPost => Boolean(post?.id && post.user?.id))
      .map((post) => [String(post.id), post]),
  );
}

/**
 * The posts above `postId` in its reply chain, root first, ending at the
 * immediate parent — or `null` when the viewer may not read `postId` itself
 * (its chain would otherwise say what it replies to).
 *
 * One recursive query and one hydration; the start post is hydrated in the same
 * batch, so the read gate costs no extra round trip. The chain stops at the
 * first ancestor the viewer may not read, where a walk of single reads stopped
 * on that ancestor's 404.
 */
export async function loadReadableAncestors(
  req: RequestSafetyContext,
  postId: string,
): Promise<HydratedPost[] | null> {
  const ancestorIds = await loadAncestorPostIds(postId, MAX_POST_ANCESTORS);
  const readable = await hydrateReadable(req, [postId, ...ancestorIds]);
  if (!readable.has(postId)) return null;
  const chain: HydratedPost[] = [];
  for (const id of ancestorIds) {
    const ancestor = readable.get(id);
    if (!ancestor) break;
    chain.push(ancestor);
  }
  return chain.reverse();
}

/** The posts with these ids the viewer may read, in the order asked for. */
export async function loadReadablePosts(
  req: RequestSafetyContext,
  ids: readonly string[],
): Promise<HydratedPost[]> {
  const readable = await hydrateReadable(req, ids);
  return ids.flatMap((id) => {
    const post = readable.get(id);
    return post ? [post] : [];
  });
}
