import { z } from 'zod';
import { Post } from '../models/Post';
import { TopicType } from '../models/Topic';
import { aliaJSON, isAliaEnabled } from '../utils/alia';
import { logger } from '../utils/logger';
import { topicService } from './TopicService';

const EXTRACTION_PROMPT = `You are a topic extractor. For each post in the array, identify up to 3 topics or named entities that the post is about.

Return a JSON array where each element is:
{ "postIndex": <number>, "topics": [{ "name": "...", "type": "topic"|"entity", "relevance": 1-10 }] }

- "topic" = abstract themes (politics, sports, tech, health, music)
- "entity" = specific people, places, organizations, events (e.g., "Barcelona", "Taylor Swift", "COP28")
- "relevance" = how central the topic is to the post (1 = tangential, 10 = primary subject)

Omit posts that have no meaningful topics (e.g., generic greetings, empty text).
Return ONLY valid JSON.`;

const ExtractedTopicSchema = z.object({
  name: z.string().min(1),
  type: z.enum(['topic', 'entity']),
  relevance: z.number().int().min(1).max(10),
});

const PostExtractionResultSchema = z.object({
  postIndex: z.number().int().min(0),
  topics: z.array(ExtractedTopicSchema).max(3),
});

const ExtractionResponseSchema = z.array(PostExtractionResultSchema);

/** Filter for posts that have not yet been processed by the extraction service. */
const UNPROCESSED_FILTER = {
  'extracted.extractedAt': { $exists: false },
} as const;

const EMPTY_EXTRACTION = (now: Date) => ({
  $set: { extracted: { topics: [], extractedAt: now } },
});

class TopicExtractionService {
  private extractionInterval: NodeJS.Timeout | null = null;
  private isExtracting = false;

  private readonly EXTRACTION_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
  private readonly BATCH_SIZE = 30;
  private readonly MAX_TEXT_LENGTH = 500;
  private readonly STALE_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes

  public start(): void {
    this.extractionInterval = setInterval(() => {
      this.processQueue().catch(error => {
        logger.error('[TopicExtraction] Processing failed:', error);
      });
    }, this.EXTRACTION_INTERVAL_MS);

    // Run once on startup after a short delay
    setTimeout(() => {
      this.processQueue().catch(error => {
        logger.error('[TopicExtraction] Initial processing failed:', error);
      });
    }, 30_000);

    logger.info('[TopicExtraction] Service started with 5-minute interval');
  }

  public stop(): void {
    if (this.extractionInterval) {
      clearInterval(this.extractionInterval);
      this.extractionInterval = null;
    }
  }

  private async processQueue(): Promise<void> {
    if (this.isExtracting) return;
    this.isExtracting = true;

    try {
      // Mark stale and media-only posts in parallel (disjoint sets, no conflict)
      await Promise.all([this.markStalePosts(), this.markMediaOnlyPosts()]);
      await this.extractTopics();
    } finally {
      this.isExtracting = false;
    }
  }

  /**
   * Mark posts older than STALE_THRESHOLD as extracted (with empty topics)
   * so they don't clog the queue forever.
   */
  private async markStalePosts(): Promise<void> {
    const staleThreshold = new Date(Date.now() - this.STALE_THRESHOLD_MS);
    const now = new Date();

    await Post.updateMany(
      {
        ...UNPROCESSED_FILTER,
        createdAt: { $lt: staleThreshold },
        'content.text': { $exists: true, $ne: '' },
        status: 'published',
        repostOf: { $exists: false },
      },
      EMPTY_EXTRACTION(now),
    );
  }

  /**
   * Mark media-only posts (no text) as extracted since there's nothing to analyze.
   * Bounded to posts older than STALE_THRESHOLD to avoid unbounded writes on cold start.
   */
  private async markMediaOnlyPosts(): Promise<void> {
    const staleThreshold = new Date(Date.now() - this.STALE_THRESHOLD_MS);
    const now = new Date();

    await Post.updateMany(
      {
        ...UNPROCESSED_FILTER,
        createdAt: { $lt: staleThreshold },
        $or: [
          { 'content.text': { $exists: false } },
          { 'content.text': '' },
        ],
      },
      EMPTY_EXTRACTION(now),
    );
  }

  /**
   * Find unprocessed posts, batch them, call Alia AI, save results.
   */
  private async extractTopics(): Promise<void> {
    if (!isAliaEnabled()) {
      return;
    }

    const posts = await Post.find({
      ...UNPROCESSED_FILTER,
      'content.text': { $exists: true, $ne: '' },
      status: 'published',
      repostOf: { $exists: false },
    })
      .select({ 'content.text': 1, createdAt: 1 })
      .sort({ createdAt: 1 })
      .limit(this.BATCH_SIZE)
      .lean();

    if (posts.length === 0) return;

    logger.info(`[TopicExtraction] Processing batch of ${posts.length} posts`);

    const payload = posts.map((post, index) => ({
      postIndex: index,
      text: (post.content?.text ?? '').slice(0, this.MAX_TEXT_LENGTH),
    }));

    try {
      const rawResult = await aliaJSON<unknown>(
        [
          { role: 'system', content: EXTRACTION_PROMPT },
          { role: 'user', content: JSON.stringify(payload) },
        ],
        { model: 'alia-lite', temperature: 0.2, maxTokens: 3000 },
      );

      const parseResult = ExtractionResponseSchema.safeParse(rawResult);
      if (!parseResult.success) {
        logger.warn('[TopicExtraction] AI response failed validation:', parseResult.error.message);
        return;
      }

      const results = parseResult.data;
      const resultByIndex = new Map(results.map(r => [r.postIndex, r]));
      const now = new Date();

      // Collect all unique topic names for batch resolution
      const allTopicEntries: Array<{ name: string; type: TopicType }> = [];
      for (const result of results) {
        for (const t of result.topics) {
          allTopicEntries.push({
            name: t.name.toLowerCase(),
            type: t.type === 'entity' ? TopicType.ENTITY : TopicType.TOPIC,
          });
        }
      }

      // Batch resolve/create Topic documents
      const topicMap = await topicService.resolveNames(allTopicEntries);

      // Update each post with extracted topics linked to Topic documents
      const popularityUpdates: Array<{ topicId: string; delta: number }> = [];
      const postCountTopicIds: string[] = [];

      const bulkOps = posts.map((post, index) => {
        const result = resultByIndex.get(index);
        const topics = (result?.topics ?? []).map(t => {
          const normalized = t.name.toLowerCase();
          const topicDoc = topicMap.get(normalized);
          const topicId = topicDoc?._id?.toString();

          if (topicId) {
            popularityUpdates.push({ topicId, delta: t.relevance });
            postCountTopicIds.push(topicId);
          }

          return {
            ...t,
            name: normalized,
            ...(topicId ? { topicId } : {}),
          };
        });

        return {
          updateOne: {
            filter: { _id: post._id },
            update: {
              $set: {
                extracted: { topics, extractedAt: now },
              },
            },
          },
        };
      });

      await Post.bulkWrite(bulkOps, { ordered: false });

      // Update Topic popularity and post counts in the background
      await Promise.all([
        topicService.batchIncrementPopularity(popularityUpdates),
        topicService.batchIncrementPostCount(postCountTopicIds),
      ]);

      const totalTopics = results.reduce((sum, r) => sum + r.topics.length, 0);
      logger.info(`[TopicExtraction] Extracted ${totalTopics} topics from ${posts.length} posts (${topicMap.size} unique topics linked)`);
    } catch (error) {
      logger.warn('[TopicExtraction] AI extraction failed, will retry next cycle:', error);
    }
  }
}

export const topicExtractionService = new TopicExtractionService();
