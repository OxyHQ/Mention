import { Router, Request, Response } from 'express';
import { trendingService } from '../services/TrendingService';
import { TimeWindow } from '../models/Trending';
import { logger } from '../utils/logger';

const router = Router();

/**
 * Get trending topics
 * GET /api/trending
 * PUBLIC ROUTE - No authentication required
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const { timeWindow = '24h', limit = '20' } = req.query;

    // Validate timeWindow
    const validTimeWindows = Object.values(TimeWindow);
    const selectedTimeWindow = validTimeWindows.includes(timeWindow as TimeWindow)
      ? (timeWindow as TimeWindow)
      : TimeWindow.TWENTY_FOUR_HOURS;

    // Validate and normalize limit (max 50)
    const limitNum = Math.min(Math.max(parseInt(limit as string, 10) || 20, 1), 50);

    // Get trending topics
    const trending = await trendingService.getTrending(selectedTimeWindow, limitNum);

    res.json({
      trending,
      timeWindow: selectedTimeWindow,
      count: trending.length
    });
  } catch (error) {
    logger.error('Error fetching trending topics:', error);
    res.status(500).json({
      message: 'Error fetching trending topics',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

export default router;
