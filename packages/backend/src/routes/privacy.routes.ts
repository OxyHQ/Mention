/**
 * The viewer's own relations-cache control.
 *
 * Blocks, restrictions and follows belong to Oxy, and the app writes them there
 * directly. Mention only READS them, through the per-viewer relations cache in
 * `utils/privacyHelpers`, which holds each viewer's four lists for a short
 * freshness window so the feed does not re-ask Oxy on every request (and keeps
 * serving the last confirmed lists while Oxy is unreachable). That window is the
 * only thing standing between a write the app just made and the feed acting on
 * it, so the client tells us when it wrote one instead of us waiting the window
 * out.
 *
 * It drops the CALLER's own entry and nothing else — the viewer id comes from the
 * authenticated session, never the request — so the endpoint cannot be used to
 * evict another account's cache or to amplify load on Oxy beyond one read.
 */

import { Router, type Response } from 'express';
import type { OxyAuthRequest as AuthRequest } from '@oxy.so/core/server';
import { invalidateViewerRelations } from '../utils/privacyHelpers';

const router = Router();

/**
 * Drop the caller's cached Oxy relations (blocked, restricted, following,
 * followers).
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
  await invalidateViewerRelations(userId);
  return res.status(204).end();
});

export default router;
