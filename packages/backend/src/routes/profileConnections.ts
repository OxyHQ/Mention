import { resolvePageLimit } from '@oxy.so/utils/paging';
import { Router, type Response } from 'express';
import { getErrorStatus } from '@oxy.so/core';
import type { OxyAuthRequest as AuthRequest } from '@oxy.so/core/server';
import { isAccountErased } from '../services/accountErasure/erasedAccounts';
import { loadProfileConnections } from '../services/federation/remoteConnections';
import { createScopedOxyClient } from '../utils/oxyHelpers';
import { logger } from '../utils/logger';
import { queryString } from '../utils/queryParams';

const router = Router();

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

/**
 * GET /api/profile/connections/:userId/:kind — `kind` is `followers` or
 * `following`. Public like Oxy's own lists; the viewer, when signed in, only
 * removes the accounts they blocked, muted or restricted. Answers
 * `{ users, hasMore, nextCursor }` (see `services/federation/remoteConnections.ts`).
 */
router.get('/:userId/:kind', async (req: AuthRequest, res: Response) => {
  const userId = String(req.params.userId ?? '');
  const kind = req.params.kind;
  if (!userId || (kind !== 'followers' && kind !== 'following')) {
    return res.status(400).json({ message: 'Unknown connections list' });
  }
  try {
    if (await isAccountErased(userId))
      return res.status(404).json({ message: 'Profile not found' });
    const limit = resolvePageLimit(req.query.limit, { fallback: DEFAULT_LIMIT, max: MAX_LIMIT });
    const page = await loadProfileConnections({
      profileUserId: userId,
      kind,
      viewerId: req.user?.id,
      oxyClient: createScopedOxyClient(req),
      cursor: queryString(req.query.cursor),
      limit,
    });
    return res.json(page);
  } catch (error) {
    // Oxy refuses the list of an account that is gone or not discoverable.
    const status = getErrorStatus(error);
    if (status === 404 || status === 403) {
      return res.status(404).json({ message: 'Profile not found' });
    }
    logger.error('[ProfileConnections] failed to load connections', { kind, error });
    return res.status(500).json({ message: 'Failed to load connections' });
  }
});

export default router;
