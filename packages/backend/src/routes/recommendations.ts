import express, { Response } from 'express';
import type { OxyAuthRequest as AuthRequest } from '@oxyhq/core/server';
import {
  recommendationService,
  MAX_RECOMMENDATION_LIMIT,
  DEFAULT_RECOMMENDATION_LIMIT,
} from '../services/RecommendationService';
import type { RecommendationExcludeType } from '../services/OxyRankingClient';
import { logger } from '../utils/logger';

const router = express.Router();

/** The user types a caller may exclude via `?excludeTypes=` (CSV). */
const VALID_EXCLUDE_TYPES: readonly RecommendationExcludeType[] = ['federated', 'agent', 'automated'];

/** Parse a CSV `excludeTypes` query param into the validated subset. */
function parseExcludeTypes(value: unknown): RecommendationExcludeType[] {
  if (typeof value !== 'string' || value.length === 0) return [];
  const parts = value.split(',').map((p) => p.trim().toLowerCase());
  return VALID_EXCLUDE_TYPES.filter((t) => parts.includes(t));
}

/** Parse the `limit` query param into a number, or undefined when absent/invalid. */
function parseLimit(value: unknown): number | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * GET /recommendations
 *
 * Public discovery surface. Mounted with `optionalAuth`, so `req.user` is set
 * for logged-in viewers and undefined otherwise. The viewer (when present) is
 * forwarded to Oxy for mutual-overlap personalization; their blocked/muted/
 * restricted users (and self) are excluded server-side. Soft-fails to an empty
 * `{ recommendations: [] }` on any downstream error.
 *
 * Query params:
 *  - `limit`        page size, default ${DEFAULT_RECOMMENDATION_LIMIT}, capped ${MAX_RECOMMENDATION_LIMIT}.
 *  - `excludeTypes` CSV of `federated,agent,automated`.
 */
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const viewerId = req.user?.id;
    const limit = parseLimit(req.query.limit);
    const excludeTypes = parseExcludeTypes(req.query.excludeTypes);

    const result = await recommendationService.getRecommendations({
      viewerId,
      limit,
      excludeTypes,
    });

    return res.json(result);
  } catch (error) {
    // The service already soft-fails internally; this is a final safety net so
    // the endpoint never 500s the discovery surface.
    logger.error('[recommendations] unexpected error:', error);
    return res.json({ recommendations: [] });
  }
});

export default router;
