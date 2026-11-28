import { Router, type Response } from 'express';
import type { OxyAuthRequest as AuthRequest } from '@oxy.so/core/server';
import type { User as OxyUser } from '@oxy.so/core';
import { apiRateLimiter } from '../middleware/rateLimiter';
import { callerOxyUser } from '../utils/oxyHelpers';
import { logger } from '../utils/logger';
import {
  getPublicProfileByHandle,
  profileHandleKey,
  viewerRelationship,
} from '../services/accounts/profileByHandle';

/**
 * `GET /profile/by-handle?handle=<handle>` — a profile by handle, local or
 * federated, resolved by Mention's backend (`services/accounts/profileByHandle`).
 *
 * The web app's profile page and hover card read a federated profile here
 * instead of asking Oxy from the browser: discovery of a remote account is
 * Mention's to start, server-to-server, under Mention's instance policy.
 *
 * Answers `{ profile: User | null }`:
 * - `profile` is the Oxy `User` the page already renders, with the viewer's
 *   `relationship` when a person is signed in (omitted for anonymous readers
 *   and for a self-view, as Oxy omits it).
 * - `null` is every way of having nothing to show, all alike: unknown,
 *   malformed, archived, restricted, erased, on a refused instance. A 200, not a
 *   404, because it is an ordinary answer (`/federation/resolve` reasons the
 *   same way), and so it never tells one kind of miss from another.
 * - 503 when Oxy could not answer: an outage, retryable, never "not found".
 *
 * Public with optional auth, behind the same per-user-or-IP limit as the
 * `/federation` routes.
 */
const router = Router();

router.use(apiRateLimiter);

router.get('/', async (req: AuthRequest, res: Response) => {
  const handle = profileHandleKey(req.query.handle);
  if (!handle) return res.json({ profile: null });

  let profile: OxyUser | null;
  try {
    profile = await getPublicProfileByHandle(handle);
  } catch (error) {
    logger.warn('[ProfileByHandle] Oxy could not resolve a profile', {
      status: (error as { status?: unknown } | null)?.status,
    });
    return res.status(503).json({ error: 'Profile lookup unavailable' });
  }
  if (!profile) return res.json({ profile: null });

  const relationship = await viewerRelationship(callerOxyUser(req), req.user?.id, profile.id);
  return res.json({ profile: relationship ? { ...profile, relationship } : profile });
});

export default router;
