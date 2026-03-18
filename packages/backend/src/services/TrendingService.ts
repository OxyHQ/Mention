import { Post } from '../models/Post';
import Trending, { TrendingType, ITrending } from '../models/Trending';
import { logger } from '../utils/logger';
import { getRedisClient } from '../utils/redis';
import { aliaJSON } from '../utils/alia';

interface AITrendItem {
  type: 'topic' | 'entity';
  name: string;
  description: string;
  relevanceScore: number;
}

interface TrendItem {
  type: TrendingType;
  name: string;
  description: string;
  score: number;
  volume: number;
  momentum: number;
}

const TREND_ANALYSIS_PROMPT = `You are a social media trend analyst. Analyze the following recent posts and identify what is currently trending.

For each trend, provide:
- type: "topic" (abstract theme like politics, sports, tech) or "entity" (specific person, place, organization, or event)
- name: A short, clear label (e.g., "Barcelona", "Donald Trump", "Justin Bieber Wedding", "Climate Summit")
- description: 1-2 sentences explaining why this is trending based on the posts
- relevanceScore: 1-10 how prominently this appears across posts

Return ONLY valid JSON: an array of objects. Return up to 10 items. Do not include hashtags (those are tracked separately).`;

class TrendingService {
  private calculationInterval: NodeJS.Timeout | null = null;
  private readonly REDIS_CACHE_TTL = 1800; // 30 minutes in seconds
  private readonly CALCULATION_INTERVAL = 1800000; // 30 minutes in milliseconds
  private readonly CLEANUP_DAYS = 30; // Remove trends older than 30 days
  private readonly MAX_POSTS_FOR_AI = 200;
  private readonly MAX_POST_TEXT_LENGTH = 200;
  private readonly MAX_CORPUS_LENGTH = 20000;

  /**
   * Initialize the service and start periodic calculations.
   */
  public initialize(): void {
    this.calculateTrending().catch(error => {
      logger.error('[Trending] Initial calculation failed:', error);
    });

    this.calculationInterval = setInterval(() => {
      this.calculateTrending().catch(error => {
        logger.error('[Trending] Periodic calculation failed:', error);
      });
    }, this.CALCULATION_INTERVAL);

    logger.info('[Trending] Service initialized with 30-minute calculation interval');
  }

  /**
   * Clean up resources.
   */
  public cleanup(): void {
    if (this.calculationInterval) {
      clearInterval(this.calculationInterval);
      this.calculationInterval = null;
    }
  }

  /**
   * Main calculation: aggregate hashtags + generate AI trends, then save as a batch.
   */
  public async calculateTrending(): Promise<void> {
    try {
      logger.info('[Trending] Starting trending calculation');

      const calculatedAt = new Date();
      const hashtagTrends = await this.aggregateHashtags();
      const aiTrends = await this.generateAITrends(hashtagTrends);

      // Merge hashtag trends and AI trends
      const allTrends: TrendItem[] = [...hashtagTrends, ...aiTrends];

      await this.saveTrendingBatch(allTrends, calculatedAt);

      logger.info(
        `[Trending] Saved batch: ${hashtagTrends.length} hashtags + ${aiTrends.length} AI trends`,
      );

      await this.invalidateCache();
      await this.cleanupOldTrends();
    } catch (error) {
      logger.error('[Trending] Error calculating trending:', error);
      throw error;
    }
  }

  /**
   * Aggregate trending hashtags from recent posts.
   */
  private async aggregateHashtags(): Promise<TrendItem[]> {
    const now = new Date();
    const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const sixHoursAgo = new Date(now.getTime() - 6 * 60 * 60 * 1000);

    const hashtags24h = await Post.aggregate([
      {
        $match: {
          createdAt: { $gte: oneDayAgo },
          hashtags: { $exists: true, $ne: [] },
        },
      },
      { $unwind: '$hashtags' },
      {
        $group: {
          _id: '$hashtags',
          count24h: { $sum: 1 },
        },
      },
    ]);

    const hashtags6h = await Post.aggregate([
      {
        $match: {
          createdAt: { $gte: sixHoursAgo },
          hashtags: { $exists: true, $ne: [] },
        },
      },
      { $unwind: '$hashtags' },
      {
        $group: {
          _id: '$hashtags',
          count6h: { $sum: 1 },
        },
      },
    ]);

    const count6hMap = new Map<string, number>();
    for (const item of hashtags6h) {
      count6hMap.set(item._id.toLowerCase(), item.count6h);
    }

    const trends: TrendItem[] = hashtags24h.map(item => {
      const hashtagName = item._id.toLowerCase();
      const volume24h = item.count24h;
      const volume6h = count6hMap.get(hashtagName) || 0;

      // Momentum: ratio of recent to overall activity
      const momentum = volume24h > 0 ? (volume6h * 4) / volume24h : 0;
      const score = volume24h * (1 + momentum * 0.5);

      return {
        type: TrendingType.HASHTAG,
        name: hashtagName,
        description: '',
        score,
        volume: volume24h,
        momentum: Math.min(momentum, 1),
      };
    });

    trends.sort((a, b) => b.score - a.score);
    return trends;
  }

  /**
   * Use Alia AI to identify trending topics and entities from recent post content.
   * Falls back gracefully if the API is unavailable.
   */
  private async generateAITrends(hashtagTrends: TrendItem[]): Promise<TrendItem[]> {
    if (!process.env.ALIA_API_KEY) {
      logger.debug('[Trending] ALIA_API_KEY not set, skipping AI trend generation');
      return [];
    }

    try {
      const sixHoursAgo = new Date(Date.now() - 6 * 60 * 60 * 1000);

      const posts = await Post.find({
        createdAt: { $gte: sixHoursAgo },
        visibility: 'public',
        'content.text': { $exists: true, $ne: '' },
      })
        .select({ 'content.text': 1, createdAt: 1 })
        .sort({ createdAt: -1 })
        .limit(this.MAX_POSTS_FOR_AI)
        .lean();

      if (posts.length === 0) {
        logger.debug('[Trending] No recent posts found for AI analysis');
        return [];
      }

      // Build corpus, truncating each post and capping total size
      let corpus = '';
      for (const post of posts) {
        const text = (post as any)?.content?.text || '';
        if (!text) continue;
        const truncated = text.slice(0, this.MAX_POST_TEXT_LENGTH);
        if (corpus.length + truncated.length + 1 > this.MAX_CORPUS_LENGTH) break;
        corpus += truncated + '\n';
      }

      if (corpus.length < 50) {
        logger.debug('[Trending] Post corpus too small for AI analysis');
        return [];
      }

      const aiResults = await aliaJSON<AITrendItem[]>(
        [
          { role: 'system', content: TREND_ANALYSIS_PROMPT },
          { role: 'user', content: `Posts:\n${corpus}` },
        ],
        { temperature: 0.3, maxTokens: 2000 },
      );

      if (!Array.isArray(aiResults)) {
        logger.warn('[Trending] AI returned non-array response');
        return [];
      }

      // Normalize AI scores to the hashtag score range
      const maxHashtagScore = hashtagTrends.length > 0
        ? hashtagTrends[0].score
        : 10;

      const trends: TrendItem[] = [];
      for (const item of aiResults) {
        if (!item.name || !item.type || !item.description) continue;
        if (item.type !== 'topic' && item.type !== 'entity') continue;

        const normalizedScore = (item.relevanceScore / 10) * maxHashtagScore;

        trends.push({
          type: item.type === 'topic' ? TrendingType.TOPIC : TrendingType.ENTITY,
          name: item.name,
          description: item.description,
          score: normalizedScore,
          volume: 0,
          momentum: 0,
        });
      }

      logger.info(`[Trending] AI generated ${trends.length} topics/entities`);
      return trends;
    } catch (error) {
      logger.warn('[Trending] AI trend generation failed, falling back to hashtags only:', error);
      return [];
    }
  }

  /**
   * Save a batch of trends (append-only — does not delete previous batches).
   */
  private async saveTrendingBatch(
    items: TrendItem[],
    calculatedAt: Date,
  ): Promise<void> {
    if (items.length === 0) return;

    // Sort by score descending for ranking
    const sorted = [...items].sort((a, b) => b.score - a.score);

    const docs = sorted.map((item, index) => ({
      type: item.type,
      name: item.name,
      description: item.description,
      score: item.score,
      volume: item.volume,
      momentum: item.momentum,
      rank: index + 1,
      calculatedAt,
      updatedAt: new Date(),
    }));

    await Trending.insertMany(docs);
    logger.debug(`[Trending] Saved ${docs.length} trends for batch ${calculatedAt.toISOString()}`);
  }

  /**
   * Get the latest batch of trends.
   */
  public async getTrending(
    limit: number = 20,
    type?: TrendingType,
  ): Promise<ITrending[]> {
    const cacheKey = `trending:latest:${limit}:${type || 'all'}`;
    const redis = await getRedisClient();

    if (redis) {
      try {
        const cached = await redis.get(cacheKey);
        if (cached) {
          logger.debug('[Trending] Cache hit for latest trends');
          return JSON.parse(cached);
        }
      } catch (cacheError) {
        logger.warn('[Trending] Redis cache read failed:', cacheError);
      }
    }

    // Find the most recent calculatedAt timestamp
    const latestDoc = await Trending.findOne()
      .sort({ calculatedAt: -1 })
      .select({ calculatedAt: 1 })
      .lean();

    if (!latestDoc) return [];

    const query: Record<string, unknown> = {
      calculatedAt: latestDoc.calculatedAt,
    };
    if (type) query.type = type;

    const trending = await Trending.find(query)
      .sort({ score: -1, rank: 1 })
      .limit(limit)
      .lean() as unknown as ITrending[];

    if (redis && trending.length > 0) {
      try {
        await redis.setEx(cacheKey, this.REDIS_CACHE_TTL, JSON.stringify(trending));
      } catch (cacheError) {
        logger.warn('[Trending] Redis cache write failed:', cacheError);
      }
    }

    return trending;
  }

  /**
   * Get paginated history of trend batches grouped by calculatedAt.
   */
  public async getTrendingHistory(
    page: number = 1,
    limit: number = 10,
  ): Promise<{ batches: Array<{ calculatedAt: Date; trends: ITrending[] }>; page: number; totalPages: number }> {
    // Get distinct calculatedAt timestamps, most recent first
    const allTimestamps = await Trending.distinct('calculatedAt') as Date[];
    allTimestamps.sort((a, b) => new Date(b).getTime() - new Date(a).getTime());

    const totalPages = Math.ceil(allTimestamps.length / limit);
    const start = (page - 1) * limit;
    const pageTimestamps = allTimestamps.slice(start, start + limit);

    if (pageTimestamps.length === 0) {
      return { batches: [], page, totalPages };
    }

    const batches: Array<{ calculatedAt: Date; trends: ITrending[] }> = [];

    for (const timestamp of pageTimestamps) {
      const trends = await Trending.find({ calculatedAt: timestamp })
        .sort({ score: -1 })
        .limit(20)
        .lean() as unknown as ITrending[];

      batches.push({ calculatedAt: timestamp, trends });
    }

    return { batches, page, totalPages };
  }

  /**
   * Remove trends older than CLEANUP_DAYS to prevent unbounded growth.
   */
  private async cleanupOldTrends(): Promise<void> {
    try {
      const cutoff = new Date(Date.now() - this.CLEANUP_DAYS * 24 * 60 * 60 * 1000);
      const result = await Trending.deleteMany({ calculatedAt: { $lt: cutoff } });

      if (result.deletedCount > 0) {
        logger.info(`[Trending] Cleaned up ${result.deletedCount} trends older than ${this.CLEANUP_DAYS} days`);
      }
    } catch (error) {
      logger.warn('[Trending] Cleanup failed:', error);
    }
  }

  /**
   * Invalidate Redis cache.
   */
  private async invalidateCache(): Promise<void> {
    try {
      const redis = await getRedisClient();
      if (!redis) return;

      const keys = await redis.keys('trending:*');
      if (keys.length > 0) {
        await redis.del(keys);
        logger.debug(`[Trending] Invalidated ${keys.length} cache keys`);
      }
    } catch {
      // Redis unavailable — cache invalidation skipped silently
    }
  }
}

// Export singleton instance
export const trendingService = new TrendingService();
