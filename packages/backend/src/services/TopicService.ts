import { TopicType } from '@oxyhq/core';
import type { TopicData, TopicTranslation } from '@oxyhq/core';
import type { ClassificationTopicRef } from '@mention/shared-types';
import { asc, desc, gte, sql } from 'drizzle-orm';
import { getDb } from '../db/postgres';
import { topicStats } from '../db/schema/discovery';
import { logger } from '../utils/logger';
import { inferenceJSON, isInferenceEnabled } from '../utils/oxyInference';
import { getServiceOxyClient } from '../utils/oxyHelpers';
import { z } from 'zod';

const KNOWN_CATEGORIES = [
  'animals', 'art', 'books', 'comedy', 'comics', 'culture', 'dev', 'education',
  'finance', 'food', 'gaming', 'journalism', 'movies', 'music', 'nature', 'news',
  'pets', 'photography', 'politics', 'science', 'sports', 'tech', 'tv', 'writers', 'none',
] as const;

/** Local post count a topic needs before AI enrichment considers it worth the tokens. */
const ENRICHMENT_MIN_POST_COUNT = 5;

class TopicService {
  private enrichmentInterval: NodeJS.Timeout | null = null;
  private initialRunTimeout: NodeJS.Timeout | null = null;
  private readonly ENRICHMENT_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

  start(): void {
    // Initial enrichment run on startup. Tracked so stop() can cancel it
    // (e.g. when leadership is lost before the initial run fires).
    this.initialRunTimeout = setTimeout(() => {
      this.initialRunTimeout = null;
      this.enrichTopics().catch(err => {
        logger.warn('[TopicService] Enrichment failed:', err);
      });
    }, 60_000);
    this.initialRunTimeout.unref?.();

    this.enrichmentInterval = setInterval(() => {
      this.enrichTopics().catch(err => {
        logger.warn('[TopicService] Enrichment failed:', err);
      });
    }, this.ENRICHMENT_INTERVAL_MS);
    this.enrichmentInterval.unref?.();

    logger.info('[TopicService] Enrichment pipeline scheduled (daily)');
  }

  stop(): void {
    if (this.enrichmentInterval) {
      clearInterval(this.enrichmentInterval);
      this.enrichmentInterval = null;
    }
    if (this.initialRunTimeout) {
      clearTimeout(this.initialRunTimeout);
      this.initialRunTimeout = null;
    }
    logger.info('[TopicService] Enrichment pipeline stopped');
  }

  // --- Topic Identity (proxied to Oxy API) ---

  async resolveNames(
    names: Array<{ name: string; type: TopicType }>,
  ): Promise<Map<string, TopicData>> {
    if (names.length === 0) return new Map();

    try {
      const oxy = getServiceOxyClient();
      const topics = await oxy.resolveTopicNames(names);
      return new Map(topics.map(t => [t.name, t]));
    } catch (error) {
      logger.error('[TopicService] Failed to resolve topic names via Oxy API:', error);
      return new Map();
    }
  }

  /**
   * Resolve a post's canonical topic slugs into {@link ClassificationTopicRef}
   * entries — the single place that links `postClassification.topics` into the
   * Topic registry. Used by the Stage-A ingest wiring and the Stage-B AI enrich
   * path so both stages produce registry-linked topics.
   *
   * Resilient by design: a name that resolves to a Topic document carries its
   * `topicId`; a name that does NOT resolve (or when the registry is unreachable)
   * is still returned WITHOUT a `topicId`. The returned list therefore always
   * mirrors the input slugs 1:1 in order — the canonical topic list is never
   * dropped just because the registry could not be reached. Personalization /
   * trending readers simply skip entries that lack a `topicId`, exactly as they
   * did with legacy data.
   *
   * @param topics canonical slugs plus optional discovered `relevance`/`type`.
   *   `type` defaults to {@link TopicType.TOPIC} for registry resolution.
   * @returns one {@link ClassificationTopicRef} per input topic, order preserved.
   */
  async resolveTopicRefs(
    topics: Array<{ name: string; relevance?: number; type?: 'topic' | 'entity' }>,
  ): Promise<ClassificationTopicRef[]> {
    if (topics.length === 0) return [];

    const resolveType = (t: 'topic' | 'entity' | undefined): TopicType =>
      t === 'entity' ? TopicType.ENTITY : TopicType.TOPIC;

    const topicMap = await this.resolveNames(
      topics.map(t => ({ name: t.name, type: resolveType(t.type) })),
    );

    return topics.map(t => {
      const topicId = topicMap.get(t.name)?._id?.toString();
      return {
        name: t.name,
        ...(topicId ? { topicId } : {}),
        ...(typeof t.relevance === 'number' ? { relevance: t.relevance } : {}),
        ...(t.type ? { type: t.type } : {}),
      };
    });
  }

  async getCategories(locale?: string): Promise<TopicData[]> {
    try {
      const oxy = getServiceOxyClient();
      return await oxy.getTopicCategories(locale);
    } catch (error) {
      logger.error('[TopicService] Failed to get categories via Oxy API:', error);
      return [];
    }
  }

  async search(query: string, limit: number = 10): Promise<TopicData[]> {
    try {
      const oxy = getServiceOxyClient();
      return await oxy.searchTopics(query, limit);
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
      return await oxy.listTopics({
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
      return await oxy.getTopicBySlug(slug);
    } catch (error) {
      logger.error('[TopicService] Failed to get topic via Oxy API:', error);
      return null;
    }
  }

  // --- App-Specific Metrics (local topic_stats) ---

  /**
   * Add `delta` to each topic's popularity, creating the row when absent.
   *
   * Mongo's `bulkWrite` of `$inc` upserts becomes ONE multi-row
   * `insert … on conflict do update`: on insert the column takes the delta
   * (which is what `$inc` on an upsert did), on conflict it takes
   * `existing + excluded`. Duplicate topic ids are summed BEFORE the statement,
   * as they were before — and now they have to be, because a single statement
   * may not touch one row twice (`ON CONFLICT DO UPDATE command cannot affect
   * row a second time`).
   *
   * `updated_at` is written explicitly: the column's `$onUpdate` fires on
   * `db.update()` only, never on a conflict branch, so leaving it out would
   * silently freeze the timestamp Mongoose's `timestamps: true` maintained.
   */
  async batchIncrementPopularity(
    updates: Array<{ topicId: string; delta: number }>,
  ): Promise<void> {
    if (updates.length === 0) return;

    const aggregated = new Map<string, number>();
    for (const { topicId, delta } of updates) {
      aggregated.set(topicId, (aggregated.get(topicId) ?? 0) + delta);
    }

    await getDb()
      .insert(topicStats)
      .values([...aggregated].map(([topicId, popularity]) => ({ topicId, popularity })))
      .onConflictDoUpdate({
        target: topicStats.topicId,
        set: {
          popularity: sql`${topicStats.popularity} + excluded.popularity`,
          updatedAt: new Date(),
        },
      });
  }

  /** Count one post per occurrence of each topic id. Same upsert shape as above. */
  async batchIncrementPostCount(topicIds: string[]): Promise<void> {
    if (topicIds.length === 0) return;

    const countMap = new Map<string, number>();
    for (const id of topicIds) {
      countMap.set(id, (countMap.get(id) ?? 0) + 1);
    }

    await getDb()
      .insert(topicStats)
      .values([...countMap].map(([topicId, postCount]) => ({ topicId, postCount })))
      .onConflictDoUpdate({
        target: topicStats.topicId,
        set: {
          postCount: sql`${topicStats.postCount} + excluded.post_count`,
          updatedAt: new Date(),
        },
      });
  }

  /**
   * Decay each topic's popularity toward its latest trending score:
   * `popularity ← popularity·decay + trendingScore·(1 − decay)`.
   *
   * The recurrence is NOT associative, so — unlike the two counters above —
   * duplicate topic ids cannot be folded into one row by summing. They do occur:
   * a name that trends as BOTH a hashtag and a classified topic resolves through
   * `resolveNames` (keyed on the name alone) to the SAME registry id, so one
   * batch can carry two updates for it, and Mongo's `bulkWrite` applied both in
   * sequence. A single Postgres statement may not touch one row twice, so the
   * updates are split into ROUNDS of distinct ids and applied in order — which
   * reproduces the sequence exactly. In practice there is one round.
   */
  async updatePopularityFromTrending(
    updates: Array<{ topicId: string; trendingScore: number }>,
    decay: number = 0.7,
  ): Promise<void> {
    if (updates.length === 0) return;

    const weight = 1 - decay;

    const rounds: Array<Array<{ topicId: string; popularity: number }>> = [];
    const roundOf = new Map<string, number>();
    for (const { topicId, trendingScore } of updates) {
      const round = roundOf.get(topicId) ?? 0;
      roundOf.set(topicId, round + 1);
      (rounds[round] ??= []).push({ topicId, popularity: trendingScore * weight });
    }

    const db = getDb();
    for (const round of rounds) {
      await db
        .insert(topicStats)
        .values(round)
        .onConflictDoUpdate({
          target: topicStats.topicId,
          set: {
            popularity: sql`${topicStats.popularity} * ${decay} + excluded.popularity`,
            updatedAt: new Date(),
          },
        });
    }
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
    if (!isInferenceEnabled()) return 0;

    try {
      // Topics with high local engagement that might need enrichment. `topic_id`
      // breaks the tie: `post_count` alone is not a total order, so without it
      // the `limit` would pick an arbitrary subset of the tied rows on every run
      // and the same topics could be enriched or skipped at random.
      const topStats = await getDb()
        .select({ topicId: topicStats.topicId })
        .from(topicStats)
        .where(gte(topicStats.postCount, ENRICHMENT_MIN_POST_COUNT))
        .orderBy(desc(topicStats.postCount), asc(topicStats.topicId))
        .limit(limit * 2);

      if (topStats.length === 0) return 0;

      const oxy = getServiceOxyClient();
      const { topics: allTopics } = await oxy.listTopics({ limit: 100 });
      const unenriched = allTopics.filter(
        t => topStats.some(s => s.topicId === t._id)
          && (!t.description || t.description === '')
          && t.type !== TopicType.CATEGORY,
      ).slice(0, limit);

      if (unenriched.length === 0) return 0;

      const names = unenriched.map(t => t.name);

      const rawResult = await inferenceJSON<unknown>(
        [
          { role: 'system', content: this.ENRICHMENT_PROMPT },
          { role: 'user', content: JSON.stringify(names) },
        ],
        { feature: 'topic-enrichment', temperature: 0.3, maxTokens: 4000 },
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
          const updateData: { description?: string; translations?: Record<string, TopicTranslation> } = {
            description: enrichment.description,
          };
          if (enrichment.translations) {
            updateData.translations = enrichment.translations;
          }

          await oxy.updateTopicMetadata(enrichment.name.toLowerCase(), updateData);
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
