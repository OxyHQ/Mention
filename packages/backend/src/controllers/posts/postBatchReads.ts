/**
 * Post reads that answer for several posts in one request: a post's ancestor
 * chain and a small batch by id.
 *
 * Both hydrate exactly as the single-post detail read (`GET /feed/item/:id`)
 * does, through the same `PostHydrationService` ACL, so they disclose nothing a
 * series of single reads would not — they only replace that series. A post this
 * viewer may not read is absent from the answer, as indistinguishable from a
 * missing one as the single read's 404 is.
 */

import type { Response } from 'express';
import type { OxyAuthRequest as AuthRequest } from '@oxy.so/core/server';
import {
  MAX_POST_ANCESTORS,
  MAX_POST_BATCH,
  type HydratedPost,
  type PostListResponse,
} from '@mention/shared-types';
import type { PostRecord } from '../../db/posts/postRecord';
import { loadAncestorPostIds, loadPostRecords } from '../../db/posts/postRepository';
import { getOrLoadPostRecords } from '../../services/postDetailCache';
import { postHydrationService } from '../../services/PostHydrationService';
import { callerOxyUser, createScopedOxyClient } from '../../utils/oxyHelpers';
import { resolveViewerPrivacyAndGraph } from '../../utils/privacyHelpers';
import { safetyRequesterFor } from '../../utils/safetyRequester';
import { queryString } from '../../utils/queryParams';
import { logger } from '../../utils/logger';

/**
 * Hydrate `records` for this request's viewer with the detail read's options,
 * keyed by id. A post hydration drops (or returns without an author) is absent.
 */
async function hydrateReadable(
  req: AuthRequest,
  records: PostRecord[],
): Promise<Map<string, HydratedPost>> {
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

const loadRecords = (ids: readonly string[]) => getOrLoadPostRecords(ids, loadPostRecords);

/**
 * `GET /posts/:id/ancestors` — the posts above `:id` in its reply chain, root
 * first, ending at the immediate parent.
 *
 * One recursive query and one hydration replace the post-detail screen's walk,
 * which read one ancestor per request. The chain stops at the first ancestor the
 * viewer may not read, where the walk stopped on that ancestor's 404. Asking
 * about a post the viewer may not read is a 404 itself: its parent chain would
 * otherwise say what it replies to.
 */
export const getPostAncestors = async (req: AuthRequest, res: Response) => {
  try {
    const postId = String(req.params.id ?? '');
    const ancestorIds = await loadAncestorPostIds(postId, MAX_POST_ANCESTORS);
    const readable = await hydrateReadable(req, await loadRecords([postId, ...ancestorIds]));
    if (!readable.has(postId)) {
      return res.status(404).json({ message: 'Post not found' });
    }

    const items: HydratedPost[] = [];
    for (const id of ancestorIds) {
      const ancestor = readable.get(id);
      if (!ancestor) break;
      items.push(ancestor);
    }
    const response: PostListResponse = { items: items.reverse() };
    return res.json(response);
  } catch (error) {
    logger.error('Error fetching post ancestors', { postId: String(req.params.id), error });
    return res.status(500).json({ message: 'Error fetching post ancestors' });
  }
};

/**
 * `GET /posts/batch?ids=a,b,c` — up to {@link MAX_POST_BATCH} posts by id, in the
 * order asked for, for screens that name several posts at once (insights' top
 * posts) and would otherwise read each one separately.
 */
export const getPostsBatch = async (req: AuthRequest, res: Response) => {
  const ids = [
    ...new Set(
      (queryString(req.query.ids) ?? '')
        .split(',')
        .map((id) => id.trim())
        .filter((id) => id.length > 0 && id.length <= 64),
    ),
  ];
  if (ids.length === 0 || ids.length > MAX_POST_BATCH) {
    return res.status(400).json({ message: 'Invalid request' });
  }

  try {
    const readable = await hydrateReadable(req, await loadRecords(ids));
    const response: PostListResponse = {
      items: ids.flatMap((id) => {
        const post = readable.get(id);
        return post ? [post] : [];
      }),
    };
    return res.json(response);
  } catch (error) {
    logger.error('Error fetching post batch', error);
    return res.status(500).json({ message: 'Error fetching posts' });
  }
};
