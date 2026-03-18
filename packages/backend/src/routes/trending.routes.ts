import { Router, Request, Response } from 'express';
import { trendingService } from '../services/TrendingService';
import { TrendingType } from '../models/Trending';
import { logger } from '../utils/logger';
import { cachePublicMedium } from '../middleware/cacheControl';

const router = Router();

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
    const { limit = '20', type } = req.query;

    const limitNum = Math.min(Math.max(parseInt(limit as string, 10) || 20, 1), 50);

    // Validate type filter
    const validTypes = Object.values(TrendingType);
    const typeFilter = validTypes.includes(type as TrendingType)
      ? (type as TrendingType)
      : undefined;

    const trending = await trendingService.getTrending(limitNum, typeFilter);

    res.json({
      trending,
      count: trending.length,
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
    const { page = '1', limit = '10' } = req.query;

    const pageNum = Math.max(parseInt(page as string, 10) || 1, 1);
    const limitNum = Math.min(Math.max(parseInt(limit as string, 10) || 10, 1), 20);

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
