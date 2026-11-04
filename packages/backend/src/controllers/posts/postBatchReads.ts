/**
 * `GET /posts/:id/ancestors` and `GET /posts/batch` — see
 * `services/postBatchReads` for what they read and why it discloses nothing a
 * series of single reads would not.
 */

import type { Response } from 'express';
import type { OxyAuthRequest as AuthRequest } from '@oxy.so/core/server';
import { MAX_POST_BATCH, type PostListResponse } from '@mention/shared-types';
import { loadReadableAncestors, loadReadablePosts } from '../../services/postBatchReads';
import { queryString } from '../../utils/queryParams';
import { logger } from '../../utils/logger';

/**
 * `GET /posts/:id/ancestors` — the reply chain above `:id`, root first. Replaces
 * the post-detail screen's walk of one read per ancestor.
 */
export const getPostAncestors = async (req: AuthRequest, res: Response) => {
  try {
    const items = await loadReadableAncestors(req, String(req.params.id ?? ''));
    if (!items) return res.status(404).json({ message: 'Post not found' });
    const response: PostListResponse = { items };
    return res.json(response);
  } catch (error) {
    logger.error('Error fetching post ancestors', { postId: String(req.params.id), error });
    return res.status(500).json({ message: 'Error fetching post ancestors' });
  }
};

/**
 * `GET /posts/batch?ids=a,b,c` — up to {@link MAX_POST_BATCH} posts by id, for
 * screens that name several posts at once (insights' top posts).
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
    const response: PostListResponse = { items: await loadReadablePosts(req, ids) };
    return res.json(response);
  } catch (error) {
    logger.error('Error fetching post batch', error);
    return res.status(500).json({ message: 'Error fetching posts' });
  }
};
