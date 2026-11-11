import type { NextFunction, Request, Response } from 'express';
import { canUseCommunities } from '@mention/shared-types/community';
import { getRequiredOxyUserId } from '@oxy.so/core/server';
import { getServiceOxyClient } from '../../utils/oxyHelpers';
import { LocalTtlCache } from '../../utils/localTtlCache';
import { logger } from '../../utils/logger';

/**
 * Communities are in a private preview (see `canUseCommunities`): the server
 * answers as if they did not exist to anyone outside it. The handle comes from
 * Oxy — `req.user` does not carry it on these paths — and is remembered for a
 * few minutes, so a request costs a lookup only the first time. A lookup that
 * fails is "not in the preview": closed, never open.
 */
const verdicts = new LocalTtlCache<boolean>({
  ttlMs: 5 * 60 * 1000,
  // A failed lookup is retried soon, but not on every request during an Oxy 429.
  negativeTtlMs: 30 * 1000,
  maxEntries: 5_000,
});

export function isInCommunitiesPreview(oxyUserId: string | null | undefined): Promise<boolean> {
  if (!oxyUserId) return Promise.resolve(false);
  return verdicts.getOrLoad(
    oxyUserId,
    async () => canUseCommunities((await getServiceOxyClient().users.get(oxyUserId))?.username),
    (error) => {
      logger.warn('[Communities] preview lookup failed; treating the account as outside it', error);
      return false;
    },
  );
}

/** An authenticated route that only the preview may reach; everyone else gets a plain 404. */
export async function requireCommunitiesPreview(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (await isInCommunitiesPreview(getRequiredOxyUserId(req as never))) return next();
  } catch {
    // No caller identity: fall through to the same 404.
  }
  res.status(404).json({ error: 'Not Found', message: 'Not Found' });
}
