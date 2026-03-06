import { Post } from '../models/Post';
import Trending, { TrendingType, TimeWindow, ITrending } from '../models/Trending';
import { logger } from '../utils/logger';
import { getRedisClient } from '../utils/redis';

class TrendingService {
  private calculationInterval: NodeJS.Timeout | null = null;
  private readonly REDIS_CACHE_TTL = 3600; // 1 hour in seconds
  private readonly CALCULATION_INTERVAL = 3600000; // 1 hour in milliseconds

  /**
   * Initialize the service and start periodic calculations
   */
  public initialize(): void {
    // Calculate immediately on startup
    this.calculateTrending().catch(error => {
      logger.error('[Trending] Initial calculation failed:', error);
    });

    // Set up periodic calculation every hour
    this.calculationInterval = setInterval(() => {
      this.calculateTrending().catch(error => {
        logger.error('[Trending] Periodic calculation failed:', error);
      });
    }, this.CALCULATION_INTERVAL);

    logger.info('[Trending] Service initialized with 1-hour calculation interval');
  }

  /**
   * Clean up resources
   */
  public cleanup(): void {
    if (this.calculationInterval) {
      clearInterval(this.calculationInterval);
      this.calculationInterval = null;
    }
  }

  /**
   * Calculate trending hashtags from recent posts
   */
  public async calculateTrending(): Promise<void> {
    try {
      logger.info('[Trending] Starting trending calculation');

      const now = new Date();
      const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      const sixHoursAgo = new Date(now.getTime() - 6 * 60 * 60 * 1000);

      // Aggregate hashtags from last 24 hours
      const hashtags24h = await Post.aggregate([
        {
          $match: {
            createdAt: { $gte: oneDayAgo },
            hashtags: { $exists: true, $ne: [] }
          }
        },
        { $unwind: '$hashtags' },
        {
          $group: {
            _id: '$hashtags',
            count24h: { $sum: 1 }
          }
        }
      ]);

      // Aggregate hashtags from last 6 hours (for momentum calculation)
      const hashtags6h = await Post.aggregate([
        {
          $match: {
            createdAt: { $gte: sixHoursAgo },
            hashtags: { $exists: true, $ne: [] }
          }
        },
        { $unwind: '$hashtags' },
        {
          $group: {
            _id: '$hashtags',
            count6h: { $sum: 1 }
          }
        }
      ]);

      // Create a map for 6h counts
      const count6hMap = new Map<string, number>();
      hashtags6h.forEach(item => {
        count6hMap.set(item._id.toLowerCase(), item.count6h);
      });

      // Calculate momentum and scores
      const trendingData = hashtags24h.map(item => {
        const hashtagName = item._id.toLowerCase();
        const volume24h = item.count24h;
        const volume6h = count6hMap.get(hashtagName) || 0;

        // Momentum: ratio of 6h activity to 24h activity (normalized to 0-1)
        // Higher momentum = more recent activity
        const momentum = volume24h > 0 ? (volume6h * 4) / volume24h : 0;

        // Score: weighted combination of volume and momentum
        // Prioritize both high volume and recent activity
        const score = volume24h * (1 + momentum * 0.5);

        return {
          name: hashtagName,
          volume: volume24h,
          momentum: Math.min(momentum, 1), // Cap at 1
          score
        };
      });

      // Sort by score descending
      trendingData.sort((a, b) => b.score - a.score);

      // Update trending collection for 24h window
      await this.updateTrendingCollection(trendingData, TimeWindow.TWENTY_FOUR_HOURS);

      logger.info(`[Trending] Calculated ${trendingData.length} trending hashtags`);

      // Invalidate Redis cache
      await this.invalidateCache();
    } catch (error) {
      logger.error('[Trending] Error calculating trending:', error);
      throw error;
    }
  }

  /**
   * Update the Trending collection with new data
   */
  private async updateTrendingCollection(
    data: Array<{ name: string; volume: number; momentum: number; score: number }>,
    timeWindow: TimeWindow
  ): Promise<void> {
    try {
      // Delete old trending data for this time window
      await Trending.deleteMany({ timeWindow });

      // Insert new trending data with ranks
      const trendingDocs = data.map((item, index) => ({
        type: TrendingType.HASHTAG,
        name: item.name,
        score: item.score,
        volume: item.volume,
        momentum: item.momentum,
        rank: index + 1,
        timeWindow,
        updatedAt: new Date()
      }));

      if (trendingDocs.length > 0) {
        await Trending.insertMany(trendingDocs);
      }

      logger.debug(`[Trending] Updated ${trendingDocs.length} documents for ${timeWindow}`);
    } catch (error) {
      logger.error('[Trending] Error updating collection:', error);
      throw error;
    }
  }

  /**
   * Get trending topics with Redis caching
   */
  public async getTrending(
    timeWindow: TimeWindow = TimeWindow.TWENTY_FOUR_HOURS,
    limit: number = 20
  ): Promise<ITrending[]> {
    try {
      // Try to get from Redis cache first
      const cacheKey = `trending:${timeWindow}:${limit}`;
      const redis = await getRedisClient();

      if (redis) {
        try {
          const cached = await redis.get(cacheKey);
          if (cached) {
            logger.debug(`[Trending] Cache hit for ${timeWindow}`);
            return JSON.parse(cached);
          }
        } catch (cacheError) {
          logger.warn('[Trending] Redis cache read failed:', cacheError);
        }
      }

      // Fetch from database
      const trending = await Trending.find({ timeWindow })
        .sort({ score: -1, rank: 1 })
        .limit(limit)
        .lean() as unknown as ITrending[];

      // Cache the result
      if (redis && trending.length > 0) {
        try {
          await redis.setEx(cacheKey, this.REDIS_CACHE_TTL, JSON.stringify(trending));
          logger.debug(`[Trending] Cached ${trending.length} items for ${timeWindow}`);
        } catch (cacheError) {
          logger.warn('[Trending] Redis cache write failed:', cacheError);
        }
      }

      return trending;
    } catch (error) {
      logger.error('[Trending] Error fetching trending:', error);
      throw error;
    }
  }

  /**
   * Invalidate Redis cache
   */
  private async invalidateCache(): Promise<void> {
    try {
      const redis = await getRedisClient();
      if (!redis) return;

      // Delete all trending cache keys
      const pattern = 'trending:*';
      const keys = await redis.keys(pattern);

      if (keys.length > 0) {
        await redis.del(keys);
        logger.debug(`[Trending] Invalidated ${keys.length} cache keys`);
      }
    } catch (error) {
      // Redis unavailable — cache invalidation skipped silently
    }
  }
}

// Export singleton instance
export const trendingService = new TrendingService();
