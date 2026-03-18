import { Post } from '../models/Post';
import Trending, { TrendingType, ITrending } from '../models/Trending';
import TrendBatch from '../models/TrendBatch';
import { logger } from '../utils/logger';
import { getRedisClient } from '../utils/redis';
import { aliaJSON } from '../utils/alia';

interface AITrendItem {
  type: 'topic' | 'entity';
  name: string;
  description: string;
  relevanceScore: number;
}

interface AITrendResponse {
  trends: AITrendItem[];
  hashtagDescriptions: Record<string, string>;
  summary: string;
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

Return a JSON object with three keys:

"trends": array of up to 10 objects, each with:
- type: "topic" (abstract theme like politics, sports, tech) or "entity" (specific person, place, organization, or event)
- name: A short, clear label (e.g., "Barcelona", "Donald Trump", "Justin Bieber Wedding", "Climate Summit")
- description: 1-2 sentences explaining why this is trending based on the posts
- relevanceScore: 1-10 how prominently this appears across posts

"hashtagDescriptions": object mapping each hashtag name (from the "Current hashtags" list) to a 1-sentence description of why it is trending based on the posts. Use the hashtag name without the # as the key.

"summary": 1-2 sentences summarizing what people are talking about right now. Be natural and engaging. Vary the phrasing.

Do not include hashtags in the trends array (those are tracked separately). Return ONLY valid JSON.`;

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
    // Drop legacy indexes from the previous schema before first calculation
    this.dropLegacyIndexes().then(() => {
      this.calculateTrending().catch(error => {
        logger.error('[Trending] Initial calculation failed:', error);
      });
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
   * Drop legacy indexes from the previous schema (timeWindow-based).
   */
  private async dropLegacyIndexes(): Promise<void> {
    try {
      const collection = Trending.collection;
      const indexes = await collection.indexes();
      const legacyIndex = indexes.find(
        (idx: any) => idx.key && 'timeWindow' in idx.key,
      );
      if (legacyIndex && legacyIndex.name) {
        await collection.dropIndex(legacyIndex.name);
        logger.info(`[Trending] Dropped legacy index: ${legacyIndex.name}`);
        // Remove old documents that used the timeWindow schema
        await Trending.deleteMany({ calculatedAt: { $exists: false } });
        logger.info('[Trending] Cleaned up legacy documents without calculatedAt');
      }
    } catch (error) {
      // Index may already be gone — safe to ignore
      logger.debug('[Trending] Legacy index drop skipped:', error);
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
      const { trends: aiTrends, hashtagDescriptions, summary } = await this.generateAITrends(hashtagTrends);

      // Merge AI-generated descriptions into hashtag trends
      if (hashtagDescriptions) {
        for (const trend of hashtagTrends) {
          const desc = hashtagDescriptions[trend.name] || hashtagDescriptions[trend.name.toLowerCase()];
          if (desc) {
            trend.description = desc;
          }
        }
      }

      const allTrends: TrendItem[] = [...hashtagTrends, ...aiTrends];

      await this.saveTrendingBatch(allTrends, calculatedAt);
      await TrendBatch.create({ calculatedAt, summary });

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
   * Aggregate trending hashtags from recent posts in a single pipeline.
   */
  private async aggregateHashtags(): Promise<TrendItem[]> {
    const now = new Date();
    const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const sixHoursAgo = new Date(now.getTime() - 6 * 60 * 60 * 1000);

    const hashtagCounts = await Post.aggregate([
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
          count6h: {
            $sum: { $cond: [{ $gte: ['$createdAt', sixHoursAgo] }, 1, 0] },
          },
        },
      },
    ]);

    const trends: TrendItem[] = hashtagCounts.map(item => {
      const hashtagName = item._id.toLowerCase();
      const volume24h = item.count24h;
      const volume6h = item.count6h;

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
   * Use Alia AI to identify trending topics/entities and generate a summary.
   * Single API call returns both trends and summary. Falls back gracefully.
   */
  private async generateAITrends(
    hashtagTrends: TrendItem[],
  ): Promise<{ trends: TrendItem[]; hashtagDescriptions: Record<string, string>; summary: string }> {
    if (!process.env.ALIA_API_KEY) {
      logger.debug('[Trending] ALIA_API_KEY not set, skipping AI trend generation');
      return { trends: [], hashtagDescriptions: {}, summary: '' };
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
        return { trends: [], hashtagDescriptions: {}, summary: '' };
      }

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
        return { trends: [], hashtagDescriptions: {}, summary: '' };
      }

      // Include hashtag names as context for better summary generation
      const hashtagContext = hashtagTrends.slice(0, 10).map(h => `#${h.name}`).join(', ');
      const userContent = hashtagContext
        ? `Current hashtags: ${hashtagContext}\n\nPosts:\n${corpus}`
        : `Posts:\n${corpus}`;

      const aiResult = await aliaJSON<AITrendResponse>(
        [
          { role: 'system', content: TREND_ANALYSIS_PROMPT },
          { role: 'user', content: userContent },
        ],
        { temperature: 0.3, maxTokens: 2000 },
      );

      const aiTrends = Array.isArray(aiResult?.trends) ? aiResult.trends : [];
      const hashtagDescriptions = (aiResult?.hashtagDescriptions && typeof aiResult.hashtagDescriptions === 'object')
        ? aiResult.hashtagDescriptions
        : {};
      const summary = typeof aiResult?.summary === 'string' ? aiResult.summary.trim() : '';

      const maxHashtagScore = hashtagTrends.length > 0
        ? hashtagTrends[0].score
        : 10;

      const trends: TrendItem[] = [];
      for (const item of aiTrends) {
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

      logger.info(`[Trending] AI generated ${trends.length} topics/entities, ${Object.keys(hashtagDescriptions).length} hashtag descriptions`);
      return { trends, hashtagDescriptions, summary };
    } catch (error) {
      logger.warn('[Trending] AI trend generation failed, falling back to hashtags only:', error);
      return { trends: [], hashtagDescriptions: {}, summary: '' };
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
   * Get the latest batch of trends with its summary.
   */
  public async getTrending(
    limit: number = 20,
    type?: TrendingType,
  ): Promise<{ trending: ITrending[]; summary: string }> {
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

    // Use TrendBatch to find the latest timestamp and summary in one query
    const latestBatch = await TrendBatch.findOne()
      .sort({ calculatedAt: -1 })
      .lean();

    if (!latestBatch) return { trending: [], summary: '' };

    const query: Record<string, unknown> = {
      calculatedAt: latestBatch.calculatedAt,
    };
    if (type) query.type = type;

    const trending = await Trending.find(query)
      .sort({ score: -1, rank: 1 })
      .limit(limit)
      .lean() as unknown as ITrending[];

    const result = { trending, summary: latestBatch.summary || '' };

    if (redis && trending.length > 0) {
      try {
        await redis.setEx(cacheKey, this.REDIS_CACHE_TTL, JSON.stringify(result));
      } catch (cacheError) {
        logger.warn('[Trending] Redis cache write failed:', cacheError);
      }
    }

    return result;
  }

  /**
   * Get paginated trending history grouped by day.
   * Deduplicates trends by name within each day, keeping the highest score.
   */
  public async getTrendingHistory(
    page: number = 1,
    limit: number = 10,
  ): Promise<{ days: Array<{ date: string; trends: ITrending[] }>; page: number; totalPages: number }> {
    // Get distinct days
    const allDays = await Trending.aggregate([
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$calculatedAt' } },
        },
      },
      { $sort: { _id: -1 } },
    ]);

    const totalPages = Math.ceil(allDays.length / limit);
    const start = (page - 1) * limit;
    const pageDays = allDays.slice(start, start + limit).map((d: any) => d._id as string);

    if (pageDays.length === 0) {
      return { days: [], page, totalPages };
    }

    // For each day, get unique trends with highest score
    const grouped = await Trending.aggregate([
      {
        $addFields: {
          day: { $dateToString: { format: '%Y-%m-%d', date: '$calculatedAt' } },
        },
      },
      { $match: { day: { $in: pageDays } } },
      { $sort: { score: -1 } },
      {
        $group: {
          _id: { day: '$day', name: '$name' },
          doc: { $first: '$$ROOT' },
        },
      },
      { $replaceRoot: { newRoot: '$doc' } },
      { $sort: { day: -1, score: -1 } },
      {
        $group: {
          _id: '$day',
          trends: { $push: '$$ROOT' },
        },
      },
      {
        $project: {
          date: '$_id',
          trends: { $slice: ['$trends', 20] },
        },
      },
      { $sort: { date: -1 } },
    ]);

    const days = grouped.map((g: any) => ({
      date: g.date as string,
      trends: g.trends as ITrending[],
    }));

    return { days, page, totalPages };
  }

  /**
   * Remove trends older than CLEANUP_DAYS to prevent unbounded growth.
   */
  private async cleanupOldTrends(): Promise<void> {
    try {
      const cutoff = new Date(Date.now() - this.CLEANUP_DAYS * 24 * 60 * 60 * 1000);
      const result = await Trending.deleteMany({ calculatedAt: { $lt: cutoff } });
      await TrendBatch.deleteMany({ calculatedAt: { $lt: cutoff } });

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
