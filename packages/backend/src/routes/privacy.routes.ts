/**
 * The viewer's own privacy-cache control.
 *
 * Blocks and restrictions belong to Oxy, and the app writes them there directly.
 * Mention only READS them, through `resolveViewerPrivacyLists`, which holds each
 * viewer's lists for a short freshness window so the feed does not re-ask Oxy on
 * every request (and keeps serving the last confirmed lists while Oxy is
 * unreachable). That window is the only thing standing between a block the app
 * just wrote and the feed acting on it, so the client tells us when it wrote one
 * instead of us waiting the window out.
 *
 * It drops the CALLER's own entry and nothing else — the viewer id comes from the
 * authenticated session, never the request — so the endpoint cannot be used to
 * evict another account's cache or to amplify load on Oxy beyond one read.
 */

import { Router, type Response } from 'express';
import type { OxyAuthRequest as AuthRequest } from '@oxy.so/core/server';
import { invalidateViewerPrivacyLists } from '../utils/privacyHelpers';

const router = Router();

/**
 * Drop the caller's cached Oxy privacy lists.
 * POST /api/privacy/refresh
 *
 * Answers 204: there is nothing to return, and the next read resolving from Oxy
 * is the whole effect. Idempotent, and a no-op when no entry is cached.
 */
router.post('/refresh', async (req: AuthRequest, res: Response) => {
  const userId = req.user?.id;
  if (!userId) {
    return res.status(401).json({ message: 'Unauthorized' });
  }

  // Never throws: the cache's fail-open contract degrades a Redis failure to a
  // no-op, which leaves the freshness window as the backstop it already was.
  await invalidateViewerPrivacyLists(userId);
  return res.status(204).end();
});

export default router;
