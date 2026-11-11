import express, { type Response } from 'express';
import type { OxyAuthRequest as AuthRequest } from '@oxy.so/core/server';
import {
  recommendationService,
  decodeRecommendationCursor,
  MAX_RECOMMENDATION_OFFSET,
  RecommendationsUnavailableError,
} from '../services/RecommendationService';
import type { RecommendationExcludeType } from '../services/OxyRankingClient';
import { logger } from '../utils/logger';
import { queryInt, queryString } from '../utils/queryParams';
import { createScopedOxyClient, createForegroundOxyProfileClient } from '../utils/oxyHelpers';

const router = express.Router();

/** The user types a caller may exclude via `?excludeTypes=` (CSV). */
const VALID_EXCLUDE_TYPES: readonly RecommendationExcludeType[] = [
  'federated',
  'agent',
  'automated',
];

/** Parse a CSV `excludeTypes` query param into the validated subset. */
function parseExcludeTypes(value: unknown): RecommendationExcludeType[] {
  if (typeof value !== 'string' || value.length === 0) return [];
  const parts = value.split(',').map((p) => p.trim().toLowerCase());
  return VALID_EXCLUDE_TYPES.filter((t) => parts.includes(t));
}

/**
 * Resolve the pagination offset from the request. Prefers an opaque `cursor`
 * (the token this endpoint emits as `nextCursor`); falls back to a raw `offset`
 * query param. Returns a validated non-negative integer (the service applies the
 * {@link MAX_RECOMMENDATION_OFFSET} cap). A malformed cursor or offset resolves
 * to `0` so the discovery surface restarts at page one rather than erroring.
 */
function parseOffset(query: AuthRequest['query']): number {
  const cursor = queryString(query.cursor);
  if (cursor) {
    const decoded = decodeRecommendationCursor(cursor);
    return decoded ?? 0;
  }
  const offset = queryInt(query.offset);
  return offset !== undefined && offset >= 0 ? offset : 0;
}

/**
 * GET /recommendations
 *
 * Public discovery surface. Mounted with `optionalAuth`, so `req.user` is set
 * for logged-in viewers and undefined otherwise. The viewer (when present) is
 * forwarded to Oxy for mutual-overlap personalization; their blocked/muted/
 * restricted users (and self) are excluded server-side. Answers 503
 * `recommendations_unavailable` when a downstream read fails, never an empty
 * page that would pass for "nobody to suggest".
 *
 * Query params:
 *  - `limit`        page size, default ${DEFAULT_RECOMMENDATION_LIMIT}, capped ${MAX_RECOMMENDATION_LIMIT}.
 *  - `cursor`       opaque pagination cursor echoed from a prior page's `nextCursor`.
 *  - `offset`       raw pagination offset (alternative to `cursor`), capped ${MAX_RECOMMENDATION_OFFSET}.
 *  - `excludeTypes` CSV of `federated,agent,automated`.
 *
 * Response:
 *  - `recommendations` the page of profiles (unchanged item shape).
 *  - `nextCursor`      opaque cursor for the next page, or `null` at the end.
 *  - `nextOffset`      numeric offset for the next page, or `null` at the end.
 *  - `hasMore`         whether another page may exist (drives infinite scroll).
 */
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const viewerId = req.user?.id;
    const limit = queryInt(req.query.limit);
    const offset = parseOffset(req.query);
    const excludeTypes = parseExcludeTypes(req.query.excludeTypes);

    const result = await recommendationService.getRecommendations({
      viewerId,
      oxyClient: createScopedOxyClient(req),
      foregroundRankingClient: createForegroundOxyProfileClient(req),
      limit,
      offset,
      excludeTypes,
    });

    return res.json(result);
  } catch (error) {
    // Never an empty 200: the client would cache "nobody to suggest" and keep
    // the surface blank after Oxy recovers. A 503 is retried, and the cached
    // page (if any) stays on screen meanwhile.
    if (!(error instanceof RecommendationsUnavailableError)) {
      logger.error('[recommendations] unexpected error:', error);
    }
    res.setHeader('Retry-After', '5');
    return res.status(503).json({ error: 'recommendations_unavailable' });
  }
});

/**
 * GET /recommendations/newest
 *
 * The newest people on Oxy, in sign-up order (most recent first). Same
 * pagination and response shape as `GET /recommendations`, minus the
 * `excludeTypes` filter (the list is local people only); the viewer's
 * blocked/muted/restricted users and self are still removed.
 */
router.get('/newest', async (req: AuthRequest, res: Response) => {
  try {
    const result = await recommendationService.getNewest({
      viewerId: req.user?.id,
      oxyClient: createScopedOxyClient(req),
      limit: queryInt(req.query.limit),
      offset: parseOffset(req.query),
    });
    return res.json(result);
  } catch (error) {
    if (!(error instanceof RecommendationsUnavailableError)) {
      logger.error('[recommendations/newest] unexpected error:', error);
    }
    res.setHeader('Retry-After', '5');
    return res.status(503).json({ error: 'recommendations_unavailable' });
  }
});

export default router;
