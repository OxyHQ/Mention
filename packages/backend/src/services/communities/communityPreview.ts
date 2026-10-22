import type { NextFunction, Request, Response } from 'express';
import { canUseCommunities } from '@mention/shared-types/community';
import { getRequiredOxyUserId } from '@oxy.so/core/server';
import { getServiceOxyClient } from '../../utils/oxyHelpers';
import { logger } from '../../utils/logger';

/**
 * Communities are in a private preview (see `canUseCommunities`): the server
 * answers as if they did not exist to anyone outside it. The handle comes from
 * Oxy — `req.user` does not carry it on these paths — and is remembered for a
 * few minutes, so a request costs a lookup only the first time. A lookup that
 * fails is "not in the preview": closed, never open.
 */
const TTL_MS = 5 * 60 * 1000;
const MAX_ENTRIES = 5_000;
const verdicts = new Map<string, { allowed: boolean; expiresAt: number }>();

export async function isInCommunitiesPreview(
  oxyUserId: string | null | undefined,
): Promise<boolean> {
  if (!oxyUserId) return false;
  const cached = verdicts.get(oxyUserId);
  if (cached && cached.expiresAt > Date.now()) return cached.allowed;
  try {
    const user = await getServiceOxyClient().users.get(oxyUserId);
    const allowed = canUseCommunities(user?.username);
    if (verdicts.size >= MAX_ENTRIES) verdicts.clear();
    verdicts.set(oxyUserId, { allowed, expiresAt: Date.now() + TTL_MS });
    return allowed;
  } catch (error) {
    logger.warn('[Communities] preview lookup failed; treating the account as outside it', error);
    return false;
  }
}

/** Test seam: forget what was learned about accounts. */
export function resetCommunitiesPreviewCache(): void {
  verdicts.clear();
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
