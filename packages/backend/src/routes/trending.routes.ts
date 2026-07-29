import { Router, Request, Response } from 'express';
import { trendingService } from '../services/TrendingService';
import { TrendingType } from '../models/Trending';
import { logger } from '../utils/logger';
import { config } from '../config';
import { cachePublicMedium } from '../middleware/cacheControl';
import { feedIPRateLimiter } from '../middleware/security';
import { parseTrendEvent, recordTrendEvent } from '../services/trending/trendTelemetry';
import { queryInt, queryString } from '../utils/queryParams';

const router = Router();

/** Trending list page size (`GET /trending`). */
const DEFAULT_TRENDING_LIMIT = 20;
const MAX_TRENDING_LIMIT = 50;

/** Trending history page size (`GET /trending/history`). */
const DEFAULT_TRENDING_HISTORY_LIMIT = 10;
const MAX_TRENDING_HISTORY_LIMIT = 20;

/**
 * Get latest trending topics.
 * GET /api/trending
 * PUBLIC ROUTE - No authentication required
 *
 * Query params:
 *   limit  — max items (1-50, default 20)
 *   type   — filter by type: hashtag, topic, entity (default: all)
 */
router.get('/', cachePublicMedium, async (req: Request, res: Response) => {
  try {
    const limitNum = Math.min(Math.max(queryInt(req.query.limit) || DEFAULT_TRENDING_LIMIT, 1), MAX_TRENDING_LIMIT);

    // Validate type filter — an unrecognized (or tampered) type means "all types".
    const rawType = queryString(req.query.type);
    const typeFilter = Object.values(TrendingType).find((trendingType) => trendingType === rawType);

    const result = await trendingService.getTrending(limitNum, typeFilter);

    res.json({
      trending: result.trending,
      summary: result.summary,
      count: result.trending.length,
      // Identifies the BATCH, so a press reported later can be attributed to it.
      // Absent only when a pre-existing cache entry predates the token.
      ...(result.recId ? { recId: result.recId } : {}),
    });
  } catch (error) {
    logger.error('Error fetching trending topics:', { error, query: req.query });
    res.status(500).json({
      message: 'Error fetching trending topics',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Get trending history (past batches).
 * GET /api/trending/history
 * PUBLIC ROUTE - No authentication required
 *
 * Query params:
 *   page  — page number (default 1)
 *   limit — batches per page (1-20, default 10)
 */
router.get('/history', cachePublicMedium, async (req: Request, res: Response) => {
  try {
    const pageNum = Math.max(queryInt(req.query.page) || 1, 1);
    const limitNum = Math.min(
      Math.max(queryInt(req.query.limit) || DEFAULT_TRENDING_HISTORY_LIMIT, 1),
      MAX_TRENDING_HISTORY_LIMIT,
    );

    const result = await trendingService.getTrendingHistory(pageNum, limitNum);

    res.json(result);
  } catch (error) {
    logger.error('Error fetching trending history:', { error, query: req.query });
    res.status(500).json({
      message: 'Error fetching trending history',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Report what a viewer did with a trend.
 * POST /api/trending/events
 * PUBLIC ROUTE - No authentication required
 *
 * Anonymous reports COUNT. This diverges from the interstitial-card endpoint,
 * which 200-no-ops for anonymous viewers because cards are only ever planned for
 * authenticated ones — whereas `/trending` is public and the widget renders for
 * signed-out visitors, so dropping their presses would bias the metric.
 *
 * Rate-limited by IP in production with the SAME limiter the feed routes use: an
 * unauthenticated public counter with no bound lets anyone inflate the metrics.
 * The limiter is on this route alone, not the router — the two GETs above are
 * CDN-cached reads that a shared office NAT should not be throttled out of.
 *
 * Body: {@link TrendEventInput}. Never persists anything; the whole handler is a
 * validation plus one in-process counter increment.
 */
router.post(
  '/events',
  ...(config.runtime.isProduction ? [feedIPRateLimiter] : []),
  async (req: Request, res: Response) => {
    const parsed = parseTrendEvent(req.body);
    if (!parsed.ok) {
      res.status(400).json({ success: false, error: parsed.error });
      return;
    }

    // The one server-side read: the token of the CURRENT batch, memoized, so the
    // client-supplied `recId` can be collapsed into a bounded `freshness` label
    // instead of ever becoming one itself.
    const currentRecId = await trendingService.getCurrentRecId();
    recordTrendEvent(parsed.input, currentRecId);

    res.json({ success: true });
  },
);

export default router;
