import Topic, { ITopic, TopicType, TopicSource } from '../models/Topic';
import { logger } from '../utils/logger';
import { aliaJSON, isAliaEnabled } from '../utils/alia';
import { z } from 'zod';

function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/[\s]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

class TopicService {
  /**
   * Atomically find or create a topic by lowercase name.
   */
  async findOrCreate(
    name: string,
    type: TopicType,
    source: TopicSource,
    displayName?: string,
  ): Promise<ITopic> {
    const normalized = name.toLowerCase().trim();
    const slug = slugify(normalized);

    const topic = await Topic.findOneAndUpdate(
      { name: normalized },
      {
        $setOnInsert: {
          name: normalized,
          slug,
          displayName: displayName ?? name,
          type,
          source,
          description: '',
          aliases: [],
          popularity: 0,
          postCount: 0,
          isActive: true,
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );

    return topic;
  }

  /**
   * Batch resolve topic names to Topic documents, creating missing ones.
   * Returns a map of lowercase name -> ITopic.
   */
  async resolveNames(
    names: Array<{ name: string; type: TopicType }>,
    source: TopicSource = TopicSource.AI,
  ): Promise<Map<string, ITopic>> {
    if (names.length === 0) return new Map();

    // Deduplicate input by lowercase name (first occurrence wins)
    const seen = new Set<string>();
    const dedupedNames: Array<{ name: string; type: TopicType }> = [];
    for (const entry of names) {
      const key = entry.name.toLowerCase().trim();
      if (!seen.has(key)) {
        seen.add(key);
        dedupedNames.push(entry);
      }
    }

    const normalizedNames = dedupedNames.map(n => n.name.toLowerCase().trim());
    const existing = await Topic.find({ name: { $in: normalizedNames } }).lean() as unknown as ITopic[];
    const existingMap = new Map(existing.map(t => [t.name, t]));

    const missing = dedupedNames.filter(n => !existingMap.has(n.name.toLowerCase().trim()));

    if (missing.length > 0) {
      const ops = missing.map(({ name, type }) => {
        const normalized = name.toLowerCase().trim();
        const slug = slugify(normalized);
        return {
          updateOne: {
            filter: { name: normalized },
            update: {
              $setOnInsert: {
                name: normalized,
                slug,
                displayName: name,
                type,
                source,
                description: '',
                aliases: [],
                popularity: 0,
                postCount: 0,
                isActive: true,
              },
            },
            upsert: true,
          },
        };
      });

      await Topic.bulkWrite(ops, { ordered: false });

      // Re-fetch the newly created topics
      const newNames = missing.map(n => n.name.toLowerCase().trim());
      const newTopics = await Topic.find({ name: { $in: newNames } }).lean() as unknown as ITopic[];
      for (const t of newTopics) {
        existingMap.set(t.name, t);
      }
    }

    return existingMap;
  }

  /**
   * Text search for topic autocomplete.
   */
  async search(query: string, limit: number = 10): Promise<ITopic[]> {
    if (!query || query.trim().length === 0) return [];

    return Topic.find(
      { $text: { $search: query }, isActive: true },
      { score: { $meta: 'textScore' } },
    )
      .sort({ score: { $meta: 'textScore' } })
      .limit(limit)
      .lean() as unknown as Promise<ITopic[]>;
  }

  /**
   * Get all category-type topics (replaces hardcoded interests list).
   */
  async getCategories(): Promise<ITopic[]> {
    return Topic.find({ type: TopicType.CATEGORY, isActive: true })
      .sort({ popularity: -1, displayName: 1 })
      .lean() as unknown as Promise<ITopic[]>;
  }

  /**
   * List topics with optional filters and pagination.
   */
  async list(options: {
    type?: TopicType;
    query?: string;
    limit?: number;
    offset?: number;
  }): Promise<{ topics: ITopic[]; total: number }> {
    const { type, query, limit = 20, offset = 0 } = options;

    const filter: Record<string, unknown> = { isActive: true };
    if (type) filter.type = type;

    if (query) {
      filter.$text = { $search: query };
    }

    const [topics, total] = await Promise.all([
      Topic.find(
        filter,
        query ? { score: { $meta: 'textScore' } } : undefined,
      )
        .sort(query ? { score: { $meta: 'textScore' } } : { popularity: -1 })
        .skip(offset)
        .limit(limit)
        .lean() as unknown as Promise<ITopic[]>,
      Topic.countDocuments(filter),
    ]);

    return { topics, total };
  }

  /**
   * Get a single topic by slug.
   */
  async getBySlug(slug: string): Promise<ITopic | null> {
    return Topic.findOne({ slug: slug.toLowerCase(), isActive: true }).lean() as unknown as Promise<ITopic | null>;
  }

  /**
   * Atomically increment a topic's popularity score.
   */
  async incrementPopularity(topicId: string, delta: number): Promise<void> {
    await Topic.updateOne({ _id: topicId }, { $inc: { popularity: delta } });
  }

  /**
   * Batch increment popularity for multiple topics.
   */
  async batchIncrementPopularity(
    updates: Array<{ topicId: string; delta: number }>,
  ): Promise<void> {
    if (updates.length === 0) return;

    const ops = updates.map(({ topicId, delta }) => ({
      updateOne: {
        filter: { _id: topicId },
        update: { $inc: { popularity: delta } },
      },
    }));

    await Topic.bulkWrite(ops, { ordered: false });
  }

  /**
   * Atomically increment a topic's post count.
   */
  async incrementPostCount(topicId: string, delta: number = 1): Promise<void> {
    await Topic.updateOne({ _id: topicId }, { $inc: { postCount: delta } });
  }

  /**
   * Batch increment post counts for multiple topics.
   */
  async batchIncrementPostCount(
    topicIds: string[],
  ): Promise<void> {
    if (topicIds.length === 0) return;

    const ops = topicIds.map(topicId => ({
      updateOne: {
        filter: { _id: topicId },
        update: { $inc: { postCount: 1 } },
      },
    }));

    await Topic.bulkWrite(ops, { ordered: false });
  }

  /**
   * Update topic popularity scores from trending data in a single round-trip.
   * Uses exponential moving average: popularity = decay * old + (1 - decay) * newScore
   * Computed server-side via MongoDB pipeline updates to avoid read-then-write races.
   */
  async updatePopularityFromTrending(
    updates: Array<{ topicId: string; trendingScore: number }>,
    decay: number = 0.7,
  ): Promise<void> {
    if (updates.length === 0) return;

    const weight = 1 - decay;

    const ops = updates.map(({ topicId, trendingScore }) => ({
      updateOne: {
        filter: { _id: topicId },
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
      },
    }));

    await Topic.bulkWrite(ops, { ordered: false });
  }

  // --- AI Topic Enrichment ---

  private readonly ENRICHMENT_PROMPT = `You are a topic classifier. For each topic name, generate:
- displayName: properly capitalized human-readable name
- description: 1-2 sentence description of this topic
- type: "category" (broad interest), "topic" (general theme), or "entity" (specific person/place/org/event)
- parentCategory: which of these categories best fits: animals, art, books, comedy, comics, culture, dev, education, finance, food, gaming, journalism, movies, music, nature, news, pets, photography, politics, science, sports, tech, tv, writers (or "none" if no fit)

Return a JSON array of objects with fields: name, displayName, description, type, parentCategory.
Return ONLY valid JSON.`;

  private readonly EnrichmentSchema = z.array(z.object({
    name: z.string(),
    displayName: z.string(),
    description: z.string(),
    type: z.enum(['category', 'topic', 'entity']),
    parentCategory: z.string(),
  }));

  /**
   * Enrich topics that lack descriptions by using AI.
   * Finds popular topics without descriptions and generates metadata.
   */
  async enrichTopics(limit: number = 20): Promise<number> {
    if (!isAliaEnabled()) return 0;

    const unenriched = await Topic.find({
      description: { $in: ['', null] },
      isActive: true,
      postCount: { $gte: 5 },
      type: { $ne: TopicType.CATEGORY }, // Categories are already well-defined
    })
      .sort({ postCount: -1 })
      .limit(limit)
      .lean();

    if (unenriched.length === 0) return 0;

    const names = unenriched.map(t => t.name);

    try {
      const rawResult = await aliaJSON<unknown>(
        [
          { role: 'system', content: this.ENRICHMENT_PROMPT },
          { role: 'user', content: JSON.stringify(names) },
        ],
        { model: 'alia-lite', temperature: 0.3, maxTokens: 3000 },
      );

      const parseResult = this.EnrichmentSchema.safeParse(rawResult);
      if (!parseResult.success) {
        logger.warn('[TopicService] AI enrichment response failed validation:', parseResult.error.message);
        return 0;
      }

      const enrichments = parseResult.data;
      const categoryTopics = await Topic.find({
        type: TopicType.CATEGORY,
        isActive: true,
      }).lean();
      const categoryMap = new Map(categoryTopics.map(c => [c.name, c._id]));

      const ops = enrichments.map(enrichment => {
        const update: Record<string, unknown> = {
          displayName: enrichment.displayName,
          description: enrichment.description,
        };

        const parentId = categoryMap.get(enrichment.parentCategory);
        if (parentId) {
          update.parentTopicId = parentId;
        }

        return {
          updateOne: {
            filter: { name: enrichment.name.toLowerCase() },
            update: { $set: update },
          },
        };
      });

      const result = await Topic.bulkWrite(ops, { ordered: false });
      const enrichedCount = result.modifiedCount;

      logger.info(`[TopicService] Enriched ${enrichedCount} topics with AI-generated metadata`);
      return enrichedCount;
    } catch (error) {
      logger.warn('[TopicService] AI enrichment failed:', error);
      return 0;
    }
  }
}

export const topicService = new TopicService();
