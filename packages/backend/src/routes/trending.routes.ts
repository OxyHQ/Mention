import { Router, Request, Response } from 'express';
import { trendingService } from '../services/TrendingService';
import { TrendingType } from '../models/Trending';
import { logger } from '../utils/logger';
import { cachePublicMedium } from '../middleware/cacheControl';
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

export default router;
