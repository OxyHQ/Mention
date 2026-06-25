import { Post } from '../models/Post';
import Trending, { TrendingType, ITrending } from '../models/Trending';
import { TopicType } from '@mention/shared-types';
import TrendBatch from '../models/TrendBatch';
import { logger } from '../utils/logger';
import { getRedisClient } from '../utils/redis';
import { emitTrendsUpdated } from '../utils/socket';
import { aliaChat, isAliaEnabled } from '../utils/alia';
import { topicService } from './TopicService';
import { isNsfwHashtag } from './contentClassification/nsfw';
// Trending shares the SINGLE canonical sensitive-exclusion clause with every
// feed (For You, Explore, ranking). Adding a new gate updates trending too.
import { SENSITIVE_EXCLUDE_MATCH } from '../mtn/feed/feedSafety';

interface TrendItem {
  type: TrendingType;
  name: string;
  description: string;
  score: number;
  volume: number;
  momentum: number;
  topicId?: string;
}

class TrendingService {
  private calculationInterval: NodeJS.Timeout | null = null;
  private readonly REDIS_CACHE_TTL = 1800; // 30 minutes in seconds
  private readonly CALCULATION_INTERVAL = 1800000; // 30 minutes in milliseconds
  private readonly CLEANUP_DAYS = 30; // Remove trends older than 30 days

  /**
   * Relevance contributed by a canonical topic ref that carries no `relevance`
   * (AI/rule topics are slug-only). Mid-scale on the 1..10 relevance axis so a
   * slug-only topic counts toward trending without dominating the relevance-aware
   * scoring; matches the neutral "present but unweighted" intent.
   */
  private static readonly DEFAULT_TOPIC_RELEVANCE = 5;

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
        (idx) => idx.key && 'timeWindow' in idx.key,
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
   * Main calculation: aggregate hashtags + topics from classified post data, then save as a batch.
   */
  public async calculateTrending(): Promise<void> {
    try {
      logger.info('[Trending] Starting trending calculation');

      const calculatedAt = new Date();
      const hashtagTrends = await this.aggregateHashtags();
      const topicTrends = await this.aggregateTopics();

      // Resolve topic names to Topic documents (topics + entities only, not hashtags)
      const topicEntries = topicTrends.map(t => ({
        name: t.name,
        type: t.type === TrendingType.ENTITY ? TopicType.ENTITY : TopicType.TOPIC,
      }));
      const topicMap = await topicService.resolveNames(topicEntries);

      // Attach topicIds to trend items
      for (const trend of topicTrends) {
        const topicDoc = topicMap.get(trend.name.toLowerCase());
        if (topicDoc) {
          trend.topicId = topicDoc._id.toString();
        }
      }

      const allTrends: TrendItem[] = [...hashtagTrends, ...topicTrends];

      // Generate AI summary from top trend names
      const topTopicNames = topicTrends.slice(0, 10).map(t => t.name);
      const topHashtagNames = hashtagTrends.slice(0, 10).map(h => `#${h.name}`);
      const popularityUpdates = topicTrends
        .filter(t => t.topicId)
        .map(t => ({ topicId: t.topicId!, trendingScore: t.score }));

      // Run AI summary generation, trend persistence, and popularity updates in parallel
      const [summary] = await Promise.all([
        this.generateSummary([...topTopicNames, ...topHashtagNames]),
        this.saveTrendingBatch(allTrends, calculatedAt),
        topicService.updatePopularityFromTrending(popularityUpdates),
      ]);
      await TrendBatch.create({ calculatedAt, summary });

      logger.info(
        `[Trending] Saved batch: ${hashtagTrends.length} hashtags + ${topicTrends.length} topics (${popularityUpdates.length} topic popularities updated)`,
      );

      await this.invalidateCache();

      // Broadcast a lightweight signal so connected clients refetch trends.
      emitTrendsUpdated(calculatedAt.toISOString());

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
          // Sensitive/NSFW-flagged posts never feed trending counts.
          ...SENSITIVE_EXCLUDE_MATCH,
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

    const trends: TrendItem[] = hashtagCounts
      // Drop blocklisted NSFW/adult hashtags even if they appear on
      // non-sensitive posts (case-insensitive, normalized in isNsfwHashtag).
      .filter(item => !isNsfwHashtag(item._id))
      .map(item => {
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
   * Aggregate trending topics from per-post classified topics.
   *
   * Reads the canonical `postClassification.topicRefs` when present and FALLS
   * BACK to the slug-only `postClassification.topics` per post (`$ifNull` on a
   * non-empty topicRefs array). The slug list is the rule-based Stage-A baseline
   * every classified post carries; each slug string is normalized to
   * `{ name: <slug> }` so the unwind/group reads `name` uniformly. The window is
   * keyed on the post's `createdAt` so both sources share one time basis. Slug
   * topics carry no `relevance`/`type`, so missing relevance contributes
   * {@link TrendingService.DEFAULT_TOPIC_RELEVANCE} and missing type defaults to
   * a TOPIC — never an `entity`. Posts with neither topic source contribute
   * nothing (the unified source is `[]`).
   */
  private async aggregateTopics(): Promise<TrendItem[]> {
    const now = new Date();
    const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const sixHoursAgo = new Date(now.getTime() - 6 * 60 * 60 * 1000);

    const topicCounts = await Post.aggregate([
      {
        $match: {
          createdAt: { $gte: oneDayAgo },
          status: 'published',
          boostOf: { $exists: false },
          // At least one topic source must be present.
          $or: [
            { 'postClassification.topicRefs': { $exists: true, $ne: [] } },
            { 'postClassification.topics': { $exists: true, $ne: [] } },
          ],
          // Sensitive/NSFW-flagged posts never feed trending topics.
          ...SENSITIVE_EXCLUDE_MATCH,
        },
      },
      {
        // Prefer the canonical topicRefs; fall back to the slug-only
        // `postClassification.topics`, mapping each slug string to a `{ name }`
        // shape so the downstream unwind/group reads `name` uniformly. `$ifNull`
        // returns the first non-null operand, and the size guard makes an empty
        // topicRefs array fall through to the slug list.
        $addFields: {
          _topicSource: {
            $cond: [
              { $gt: [{ $size: { $ifNull: ['$postClassification.topicRefs', []] } }, 0] },
              '$postClassification.topicRefs',
              {
                $map: {
                  input: { $ifNull: ['$postClassification.topics', []] },
                  as: 'name',
                  in: { name: '$$name' },
                },
              },
            ],
          },
        },
      },
      { $unwind: '$_topicSource' },
      {
        $group: {
          _id: {
            name: '$_topicSource.name',
            // Canonical refs may omit `type`; default to 'topic' (never entity).
            type: { $ifNull: ['$_topicSource.type', 'topic'] },
          },
          // Canonical refs may omit `relevance`; default to a neutral value so a
          // slug-only topic still contributes to the trending volume/score.
          totalRelevance: {
            $sum: { $ifNull: ['$_topicSource.relevance', TrendingService.DEFAULT_TOPIC_RELEVANCE] },
          },
          postCount: { $sum: 1 },
          recentCount: {
            $sum: { $cond: [{ $gte: ['$createdAt', sixHoursAgo] }, 1, 0] },
          },
        },
      },
      {
        $match: { postCount: { $gte: 2 } },
      },
    ]);

    const trends: TrendItem[] = topicCounts
      // Drop blocklisted NSFW/adult topic slugs from trending topics.
      .filter(item => !isNsfwHashtag(item._id.name))
      .map(item => {
        const momentum = item.postCount > 0
          ? Math.min((item.recentCount * 4) / item.postCount, 1)
          : 0;
        const score = item.totalRelevance * (1 + momentum * 0.5);

        return {
          type: item._id.type === 'topic' ? TrendingType.TOPIC : TrendingType.ENTITY,
          name: item._id.name,
          description: '',
          score,
          volume: item.postCount,
          momentum,
        };
      });

    trends.sort((a, b) => b.score - a.score);
    return trends.slice(0, 15);
  }

  /**
   * Generate a lightweight AI summary from trend names.
   */
  private async generateSummary(trendNames: string[]): Promise<string> {
    if (!isAliaEnabled() || trendNames.length === 0) {
      return '';
    }

    try {
      const summary = await aliaChat(
        [
          {
            role: 'system',
            content: 'You are a social media trend analyst. Given a list of trending topics, write a 1-2 sentence summary of what people are talking about right now. Be natural and engaging. Vary the phrasing. Return ONLY the summary text.',
          },
          {
            role: 'user',
            content: `Trending: ${trendNames.join(', ')}`,
          },
        ],
        { temperature: 0.5 },
      );

      return summary.trim();
    } catch (error) {
      logger.warn('[Trending] Summary generation failed:', error);
      return '';
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
      ...(item.topicId ? { topicId: item.topicId } : {}),
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
    const allDays = await Trending.aggregate<{ _id: string }>([
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$calculatedAt' } },
        },
      },
      { $sort: { _id: -1 } },
    ]);

    const totalPages = Math.ceil(allDays.length / limit);
    const start = (page - 1) * limit;
    const pageDays = allDays.slice(start, start + limit).map((d) => d._id);

    if (pageDays.length === 0) {
      return { days: [], page, totalPages };
    }

    // For each day, get unique trends with highest score
    const grouped = await Trending.aggregate<{ date: string; trends: ITrending[] }>([
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

    const days = grouped.map((g) => ({
      date: g.date,
      trends: g.trends,
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
