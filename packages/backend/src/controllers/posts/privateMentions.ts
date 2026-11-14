import { resolvePageLimit } from '@oxy.so/utils/paging';
import type { Response } from 'express';
import type { OxyAuthRequest as AuthRequest } from '@oxy.so/core/server';
import { listPrivateMentionConversationsPage } from '../../services/privateMentionService';
import { decodeChronoCursor } from '../../utils/chronoCursor';
import { respondWithApiError } from '../../utils/error';
import { logger } from '../../utils/logger';
import { createScopedOxyClient } from '../../utils/oxyHelpers';
import { queryString } from '../../utils/queryParams';
import { safetyRequesterFor } from '../../utils/safetyRequester';
import { requestLanguageCandidates } from '../../utils/viewerLanguage';
import { POST_PAGE_LIMIT } from './postPageBounds';

/**
 * `GET /posts/private-mentions` — the viewer's private-mention conversations,
 * newest activity first (`listPrivateMentionConversationsPage`). Reading one is
 * the thread view's job: `GET /posts/:rootId` and `GET /feed/replies/:rootId`
 * admit the conversation's participants.
 *
 * Query: `limit` (bounded by {@link POST_PAGE_LIMIT}),
 * `cursor` (the previous page's opaque `nextCursor`; a malformed one is a 400).
 */
export const getPrivateMentionConversations = async (req: AuthRequest, res: Response) => {
  try {
    const viewerId = req.user?.id;
    if (!viewerId) return res.status(401).json({ message: 'Unauthorized' });

    const limit = resolvePageLimit(req.query.limit, POST_PAGE_LIMIT);
    const rawCursor = queryString(req.query.cursor);
    const cursor = rawCursor ? decodeChronoCursor(rawCursor) : undefined;
    if (rawCursor && !cursor) return res.status(400).json({ message: 'Invalid cursor' });

    const body = await listPrivateMentionConversationsPage(
      viewerId,
      { limit, ...(cursor ? { cursor } : {}) },
      {
        safetyRequester: safetyRequesterFor(req),
        oxyClient: createScopedOxyClient(req),
        requestLanguages: requestLanguageCandidates(req),
        includeLinkMetadata: true,
      },
    );
    res.setHeader('Cache-Control', 'private, no-store');
    return res.json(body);
  } catch (error) {
    if (respondWithApiError(res, error)) return;
    logger.error('[getPrivateMentionConversations] Error:', error);
    return res.status(500).json({ message: 'Error fetching private mentions' });
  }
};
