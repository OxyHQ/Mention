import { TopicType } from '@mention/shared-types';
import type { TopicData } from '@mention/shared-types';
import TopicStats from '../models/TopicStats';
import { logger } from '../utils/logger';
import { aliaJSON, isAliaEnabled } from '../utils/alia';
import { getServiceOxyClient } from '../utils/oxyHelpers';
import { z } from 'zod';

const KNOWN_CATEGORIES = [
  'animals', 'art', 'books', 'comedy', 'comics', 'culture', 'dev', 'education',
  'finance', 'food', 'gaming', 'journalism', 'movies', 'music', 'nature', 'news',
  'pets', 'photography', 'politics', 'science', 'sports', 'tech', 'tv', 'writers', 'none',
] as const;

class TopicService {
  private enrichmentInterval: NodeJS.Timeout | null = null;
  private readonly ENRICHMENT_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

  start(): void {
    setTimeout(() => {
      this.enrichTopics().catch(err => {
        logger.warn('[TopicService] Enrichment failed:', err);
      });
    }, 60_000);

    this.enrichmentInterval = setInterval(() => {
      this.enrichTopics().catch(err => {
        logger.warn('[TopicService] Enrichment failed:', err);
      });
    }, this.ENRICHMENT_INTERVAL_MS);

    logger.info('[TopicService] Enrichment pipeline scheduled (daily)');
  }

  stop(): void {
    if (this.enrichmentInterval) {
      clearInterval(this.enrichmentInterval);
      this.enrichmentInterval = null;
    }
  }

  // --- Topic Identity (proxied to Oxy API) ---

  async resolveNames(
    names: Array<{ name: string; type: TopicType }>,
  ): Promise<Map<string, TopicData>> {
    if (names.length === 0) return new Map();

    try {
      const oxy = getServiceOxyClient();
      const topics: TopicData[] = await (oxy as any).resolveTopicNames(names);
      return new Map(topics.map(t => [t.name, t]));
    } catch (error) {
      logger.error('[TopicService] Failed to resolve topic names via Oxy API:', error);
      return new Map();
    }
  }

  async getCategories(locale?: string): Promise<TopicData[]> {
    try {
      const oxy = getServiceOxyClient();
      return await (oxy as any).getTopicCategories(locale);
    } catch (error) {
      logger.error('[TopicService] Failed to get categories via Oxy API:', error);
      return [];
    }
  }

  async search(query: string, limit: number = 10): Promise<TopicData[]> {
    try {
      const oxy = getServiceOxyClient();
      return await (oxy as any).searchTopics(query, limit);
    } catch (error) {
      logger.error('[TopicService] Failed to search topics via Oxy API:', error);
      return [];
    }
  }

  async list(options: {
    type?: TopicType;
    query?: string;
    limit?: number;
    offset?: number;
    locale?: string;
  }): Promise<{ topics: TopicData[]; total: number }> {
    try {
      const oxy = getServiceOxyClient();
      return await (oxy as any).listTopics({
        type: options.type,
        q: options.query,
        limit: options.limit,
        offset: options.offset,
        locale: options.locale,
      });
    } catch (error) {
      logger.error('[TopicService] Failed to list topics via Oxy API:', error);
      return { topics: [], total: 0 };
    }
  }

  async getBySlug(slug: string): Promise<TopicData | null> {
    try {
      const oxy = getServiceOxyClient();
      return await (oxy as any).getTopicBySlug(slug);
    } catch (error) {
      logger.error('[TopicService] Failed to get topic via Oxy API:', error);
      return null;
    }
  }

  // --- App-Specific Metrics (local TopicStats) ---

  async batchIncrementPopularity(
    updates: Array<{ topicId: string; delta: number }>,
  ): Promise<void> {
    if (updates.length === 0) return;

    const aggregated = new Map<string, number>();
    for (const { topicId, delta } of updates) {
      aggregated.set(topicId, (aggregated.get(topicId) ?? 0) + delta);
    }

    const ops = Array.from(aggregated.entries()).map(([topicId, delta]) => ({
      updateOne: {
        filter: { topicId },
        update: { $inc: { popularity: delta } },
        upsert: true,
      },
    }));

    await TopicStats.bulkWrite(ops, { ordered: false });
  }

  async batchIncrementPostCount(
    topicIds: string[],
  ): Promise<void> {
    if (topicIds.length === 0) return;

    const countMap = new Map<string, number>();
    for (const id of topicIds) {
      countMap.set(id, (countMap.get(id) ?? 0) + 1);
    }

    const ops = Array.from(countMap.entries()).map(([topicId, count]) => ({
      updateOne: {
        filter: { topicId },
        update: { $inc: { postCount: count } },
        upsert: true,
      },
    }));

    await TopicStats.bulkWrite(ops, { ordered: false });
  }

  async updatePopularityFromTrending(
    updates: Array<{ topicId: string; trendingScore: number }>,
    decay: number = 0.7,
  ): Promise<void> {
    if (updates.length === 0) return;

    const weight = 1 - decay;

    const ops = updates.map(({ topicId, trendingScore }) => ({
      updateOne: {
        filter: { topicId },
        update: [
          {
            $set: {
              popularity: {
                $add: [
                  { $multiply: [{ $ifNull: ['$popularity', 0] }, decay] },
                  trendingScore * weight,
                ],
              },
            },
          },
        ],
        upsert: true,
      },
    }));

    await TopicStats.bulkWrite(ops, { ordered: false });
  }

  // --- AI Topic Enrichment ---

  private readonly ENRICHMENT_PROMPT = `You are a topic classifier for a multilingual social media platform. For each topic name, generate metadata.

For each topic, provide:
- displayName: properly capitalized human-readable name in English
- description: 1-2 sentence English description (50-200 characters). Be factual and neutral.
- type: "category" (broad interest like sports, tech, music), "topic" (specific theme like basketball, machine learning), or "entity" (specific person, place, organization, event)
- parentCategory: which broad category best fits. Choose from: animals, art, books, comedy, comics, culture, dev, education, finance, food, gaming, journalism, movies, music, nature, news, pets, photography, politics, science, sports, tech, tv, writers. Use "none" if no category fits.
- translations: localized displayName and description for es-ES (Spanish) and ca-ES (Catalan). SKIP translations for entities (names of people, cities, organizations are universal).

Return a JSON array of objects:
{ "name": "...", "displayName": "...", "description": "...", "type": "...", "parentCategory": "...", "translations": { "es-ES": { "displayName": "...", "description": "..." }, "ca-ES": { "displayName": "...", "description": "..." } } }

For entities, set translations to null or omit it.
Return ONLY valid JSON.`;

  private readonly EnrichmentSchema = z.array(z.object({
    name: z.string(),
    displayName: z.string().max(100),
    description: z.string().min(10).max(300),
    type: z.enum(['category', 'topic', 'entity']),
    parentCategory: z.enum(KNOWN_CATEGORIES),
    translations: z.record(z.string(), z.object({
      displayName: z.string(),
      description: z.string().optional(),
    })).nullable().optional(),
  }));

  /**
   * Enrich topics that lack descriptions by using AI.
   * Finds popular topics from local stats, then writes metadata back to Oxy.
   */
  async enrichTopics(limit: number = 20): Promise<number> {
    if (!isAliaEnabled()) return 0;

    try {
      // Find topics with high local engagement that might need enrichment
      const topStats = await TopicStats.find({ postCount: { $gte: 5 } })
        .sort({ postCount: -1 })
        .limit(limit * 2)
        .lean();

      if (topStats.length === 0) return 0;

      const oxy = getServiceOxyClient();
      const { topics: allTopics } = await (oxy as any).listTopics({ limit: 100 });
      const unenriched = (allTopics as TopicData[]).filter(
        t => topStats.some(s => s.topicId === t._id)
          && (!t.description || t.description === '')
          && t.type !== 'category',
      ).slice(0, limit);

      if (unenriched.length === 0) return 0;

      const names = unenriched.map(t => t.name);

      const rawResult = await aliaJSON<unknown>(
        [
          { role: 'system', content: this.ENRICHMENT_PROMPT },
          { role: 'user', content: JSON.stringify(names) },
        ],
        { model: 'alia-lite', temperature: 0.3, maxTokens: 4000 },
      );

      const parseResult = this.EnrichmentSchema.safeParse(rawResult);
      if (!parseResult.success) {
        logger.warn('[TopicService] AI enrichment response failed validation:', parseResult.error.message);
        return 0;
      }

      const enrichments = parseResult.data;
      let enrichedCount = 0;

      for (const enrichment of enrichments) {
        try {
          const updateData: Record<string, unknown> = {
            description: enrichment.description,
          };
          if (enrichment.translations) {
            updateData.translations = enrichment.translations;
          }

          await (oxy as any).updateTopicMetadata(enrichment.name.toLowerCase(), updateData);
          enrichedCount++;
        } catch (err) {
          logger.warn(`[TopicService] Failed to update topic "${enrichment.name}" via Oxy:`, err);
        }
      }

      logger.info(`[TopicService] Enriched ${enrichedCount} topics with AI-generated metadata`);
      return enrichedCount;
    } catch (error) {
      logger.warn('[TopicService] AI enrichment failed:', error);
      return 0;
    }
  }
}

export const topicService = new TopicService();
