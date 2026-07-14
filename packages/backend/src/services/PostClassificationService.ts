import { z } from 'zod';
import type { AnyBulkWriteOperation, Types } from 'mongoose';
import { Post, type IPost } from '../models/Post';
import type { PostClassificationScores, PostContent } from '@mention/shared-types';
import { aliaJSON, isAliaEnabled } from '../utils/alia';
import { logger } from '../utils/logger';
import { config } from '../config';
import { topicService } from './TopicService';
import { resolveVariant } from './postVariants';
import type { ClassificationTopicRef } from '@mention/shared-types';

/**
 * AI-powered post classification service.
 *
 * A leader-gated batch processor that finds unclassified posts, sends them to the
 * Alia AI gateway for strict structured-JSON classification, validates the
 * response with zod, and persists internal `postClassification` metadata (topics,
 * topicRefs, sentiment, intent, quality/safety scores). This is the ONE topic
 * system: it refines the canonical `postClassification.topics`/`topicRefs` list
 * seeded synchronously by the Stage-A baseline classifier at ingest.
 *
 * Design contracts:
 * - Classification is asynchronous and NEVER blocks post creation. New posts are
 *   created with `postClassification.status = 'pending'` (a Mongoose default on
 *   the subdoc) and picked up here on the next cycle.
 * - The AI provider/model is an Alia infrastructure concern — it is NEVER
 *   written to the post document.
 * - Failures are isolated per batch: a parse/validation/network failure marks
 *   the affected posts for retry and flips them to `failed` only after the retry
 *   budget is exhausted. The batch loop never throws out to the caller.
 */

const CLASSIFICATION_PROMPT = `You are a content classifier for a social media platform. For each post, infer internal metadata used for ranking, search, recommendations, and moderation. This is SEPARATE from user hashtags — analyze the meaning of the content itself.

Classify regardless of the post's language. All scores are floats from 0.0 to 1.0.

Fields:
- topics: up to 5 lowercase, snake_case inferred topics/tags (e.g. "product_feedback", "feed", "machine_learning"). Inferred from content, NOT copied hashtags. Use [] if none.
- sentiment: one of "positive", "neutral", "negative", "mixed". Use "mixed" when the post is both positive and negative (e.g. constructive criticism).
- intent: one of "question", "announcement", "feedback", "opinion", "complaint", "joke", "news", "personal_update", "other".
- scores:
  - toxicity: 0 = civil; 1 = harassing, abusive, hateful.
  - constructiveness: 0 = adds nothing; 1 = clearly constructive / adds value (even when critical).
  - spam: 0 = genuine; 1 = spam, scam, or low-effort promotion.
  - quality: 0 = empty/low-effort; 1 = clear, substantive, high-effort.
  - controversy: 0 = uncontroversial; 1 = highly divisive.
  - negativity: 0 = no negative tone; 1 = strongly negative tone. Independent of toxicity — legitimate criticism can be negative but NOT toxic.
- confidence: 0..1 — your overall confidence in this classification.

Important: negativity and toxicity are different. Constructive criticism is often negative but NOT toxic, and has HIGH constructiveness. Reserve high toxicity for insults, harassment, and abuse.

Examples:
Input: { "text": "I love how much faster the Mention feed feels now." }
Output: { "topics": ["mention", "product_feedback", "feed"], "sentiment": "positive", "intent": "feedback", "scores": { "toxicity": 0, "constructiveness": 0.8, "spam": 0, "quality": 0.75, "controversy": 0, "negativity": 0 }, "confidence": 0.9 }

Input: { "text": "The new feed still breaks when refreshing, but the direction is good." }
Output: { "topics": ["mention", "product_feedback", "bugs", "feed"], "sentiment": "mixed", "intent": "feedback", "scores": { "toxicity": 0, "constructiveness": 0.85, "spam": 0, "quality": 0.8, "controversy": 0.1, "negativity": 0.45 }, "confidence": 0.88 }

Input: { "text": "This is trash and everyone here is stupid." }
Output: { "topics": ["general_complaint"], "sentiment": "negative", "intent": "complaint", "scores": { "toxicity": 0.85, "constructiveness": 0.05, "spam": 0, "quality": 0.15, "controversy": 0.5, "negativity": 0.95 }, "confidence": 0.9 }

Return a JSON array where each element is:
{ "postIndex": <number>, "topics": [...], "sentiment": "...", "intent": "...", "scores": { ... }, "confidence": <number> }

Return ONLY valid JSON. Include every input post exactly once.`;

const score = () => z.number().min(0).max(1);

const ClassificationScoresSchema = z.object({
  toxicity: score(),
  constructiveness: score(),
  spam: score(),
  quality: score(),
  controversy: score(),
  negativity: score(),
});

const PostClassificationResultSchema = z.object({
  postIndex: z.number().int().min(0),
  topics: z.array(z.string().min(1).max(60).transform(s => s.toLowerCase().trim())).max(5).default([]),
  sentiment: z.enum(['positive', 'neutral', 'negative', 'mixed']),
  intent: z.enum(['question', 'announcement', 'feedback', 'opinion', 'complaint', 'joke', 'news', 'personal_update', 'other']),
  scores: ClassificationScoresSchema,
  confidence: score(),
});

const ClassificationResponseSchema = z.array(PostClassificationResultSchema);

type ClassificationResult = z.infer<typeof PostClassificationResultSchema>;

/** Minimal projection of a post pulled into the classification queue. */
interface QueueDoc {
  _id: Types.ObjectId;
  content: PostContent;
  postClassification?: { attempts?: number };
}

/**
 * Filter for posts that have not been successfully classified yet — either the
 * subdoc is missing entirely (legacy/raw-inserted docs) or it is still `pending`
 * or `failed`-but-under-budget. The retry cap is enforced via `attempts`.
 */
const UNCLASSIFIED_FILTER: Record<string, unknown> = {
  $or: [
    { postClassification: { $exists: false } },
    { 'postClassification.status': 'pending' },
  ],
};

class PostClassificationService {
  private classificationInterval: NodeJS.Timeout | null = null;
  private initialRunTimeout: NodeJS.Timeout | null = null;
  private isClassifying = false;

  private readonly CLASSIFICATION_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
  private readonly INITIAL_RUN_DELAY_MS = 30_000;
  private readonly BATCH_SIZE = 25;
  private readonly MAX_TEXT_LENGTH = 1000;
  private readonly MAX_ATTEMPTS = 3;
  private readonly AI_MODEL = 'alia-lite';
  private readonly AI_TEMPERATURE = 0.2;
  private readonly AI_MAX_TOKENS = 4000;

  public start(): void {
    if (!config.classification.enabled) {
      logger.info('[PostClassification] Disabled (POST_CLASSIFICATION_ENABLED not set) — service not started');
      return;
    }

    this.classificationInterval = setInterval(() => {
      this.processQueue().catch(error => {
        logger.error('[PostClassification] Processing failed:', error);
      });
    }, this.CLASSIFICATION_INTERVAL_MS);
    this.classificationInterval.unref?.();

    // Run once on startup after a short delay. Tracked so stop() can cancel it
    // if leadership is lost before the initial run fires.
    this.initialRunTimeout = setTimeout(() => {
      this.initialRunTimeout = null;
      this.processQueue().catch(error => {
        logger.error('[PostClassification] Initial processing failed:', error);
      });
    }, this.INITIAL_RUN_DELAY_MS);
    this.initialRunTimeout.unref?.();

    logger.info('[PostClassification] Service started with 5-minute interval');
  }

  public stop(): void {
    if (this.classificationInterval) {
      clearInterval(this.classificationInterval);
      this.classificationInterval = null;
    }
    if (this.initialRunTimeout) {
      clearTimeout(this.initialRunTimeout);
      this.initialRunTimeout = null;
    }
    logger.info('[PostClassification] Service stopped');
  }

  /**
   * Single processing cycle: re-queue stale failed posts, mark text-less posts
   * as classified (nothing to analyze), then classify a batch. Re-entrancy is
   * guarded so overlapping intervals never double-process.
   */
  public async processQueue(): Promise<void> {
    if (this.isClassifying) return;
    if (!config.classification.enabled || !isAliaEnabled()) return;
    this.isClassifying = true;

    try {
      await this.markEmptyPosts();
      await this.classifyBatch();
    } finally {
      this.isClassifying = false;
    }
  }

  /**
   * Mark posts with no analyzable text as `classified` with neutral defaults so
   * they don't clog the queue forever (there is nothing to infer from media-only
   * posts). Bounded to the pending set.
   */
  private async markEmptyPosts(): Promise<void> {
    const now = new Date();
    await Post.updateMany(
      {
        'postClassification.status': 'pending',
        // No rendition at all = nothing to infer from (a boost, a media-only
        // post). The body lives only in the variants, so "no text" is "no
        // variant".
        'content.variants.0': { $exists: false },
      },
      {
        $set: {
          'postClassification.status': 'classified',
          'postClassification.classifiedAt': now,
        },
      },
    );
  }

  /**
   * Find unclassified posts, batch them, call Alia AI, and persist the results.
   * On any failure the affected posts are marked for retry (and flipped to
   * `failed` once the retry budget is exhausted) — never thrown out of the loop.
   */
  private async classifyBatch(): Promise<void> {
    const posts = await Post.find({
      ...UNCLASSIFIED_FILTER,
      'content.variants.0': { $exists: true },
      status: 'published',
      boostOf: { $exists: false },
    })
      .select({ 'content.variants': 1, createdAt: 1, 'postClassification.attempts': 1 })
      .sort({ createdAt: 1 })
      .limit(this.BATCH_SIZE)
      .lean<QueueDoc[]>();

    if (posts.length === 0) return;

    logger.info(`[PostClassification] Classifying batch of ${posts.length} posts`);

    // Classify the PRIMARY rendition — what the author actually wrote. A machine
    // translation is derived from it and would only feed the classifier its own
    // output back; a second author language says the same thing twice.
    const payload = posts.map((post, index) => ({
      postIndex: index,
      text: resolveVariant(post.content).text.slice(0, this.MAX_TEXT_LENGTH),
    }));

    let results: ClassificationResult[];
    try {
      const rawResult = await aliaJSON<unknown>(
        [
          { role: 'system', content: CLASSIFICATION_PROMPT },
          { role: 'user', content: JSON.stringify(payload) },
        ],
        { model: this.AI_MODEL, temperature: this.AI_TEMPERATURE, maxTokens: this.AI_MAX_TOKENS },
      );

      const parseResult = ClassificationResponseSchema.safeParse(rawResult);
      if (!parseResult.success) {
        logger.warn('[PostClassification] AI response failed validation:', parseResult.error.message);
        await this.recordFailures(posts);
        return;
      }
      results = parseResult.data;
    } catch (error) {
      logger.warn('[PostClassification] AI classification failed, will retry:', error);
      await this.recordFailures(posts);
      return;
    }

    const resultByIndex = new Map(results.map(r => [r.postIndex, r]));
    const now = new Date();

    // Resolve every AI-refined topic across the batch into the Topic registry in
    // ONE pass (single Oxy round trip), then build per-post `topicRefs`. This
    // registry linkage keeps personalization (topicId match) and trending
    // (TopicStats) working off the canonical `postClassification` list.
    const topicRefsByIndex = await this.resolveBatchTopicRefs(results);

    const bulkOps: AnyBulkWriteOperation<IPost>[] = posts.map((post, index) => {
      const result = resultByIndex.get(index);

      if (!result) {
        // Missing entry for this post — count an attempt and retry/expire it.
        return this.failureUpdateOp(post, now);
      }

      // Dotted $set of ONLY the AI-owned (Stage-B) fields. A whole-subdoc
      // overwrite (`$set: { postClassification }`) would wipe the Stage-A
      // deterministic fields (language, region, hashtagsNorm, version, sensitive)
      // populated at ingest, so the two stages must merge, not replace. `topics`
      // is shared and intentionally refined here by the AI; `topicRefs` is its
      // registry-resolved form (the canonical list readers consume).
      return {
        updateOne: {
          filter: { _id: post._id },
          update: {
            $set: {
              'postClassification.topics': result.topics,
              'postClassification.topicRefs': topicRefsByIndex.get(index) ?? [],
              'postClassification.sentiment': result.sentiment,
              'postClassification.intent': result.intent,
              'postClassification.scores': this.normalizeScores(result.scores),
              'postClassification.confidence': result.confidence,
              'postClassification.status': 'classified',
              'postClassification.attempts': this.attemptsOf(post),
              'postClassification.classifiedAt': now,
            },
          },
        },
      };
    });

    await Post.bulkWrite(bulkOps, { ordered: false });

    const classifiedCount = posts.filter((_, i) => resultByIndex.has(i)).length;
    logger.info(`[PostClassification] Classified ${classifiedCount}/${posts.length} posts`);
  }

  /**
   * Resolve the AI-refined topics of every result in a batch into registry-linked
   * {@link ClassificationTopicRef} lists, keyed by `postIndex`. Resolution is
   * batched across the whole AI batch (one Oxy round trip via
   * {@link TopicService.resolveTopicRefs}) for efficiency.
   *
   * Best-effort: if registry resolution throws (e.g. Oxy unreachable), every
   * topic still yields a `name`-only ref so the canonical list is preserved —
   * readers that need a `topicId` simply skip those entries. AI topics carry no
   * relevance/type, so refs hold the slug + (when resolved) `topicId` only.
   */
  private async resolveBatchTopicRefs(
    results: ClassificationResult[],
  ): Promise<Map<number, ClassificationTopicRef[]>> {
    const byIndex = new Map<number, ClassificationTopicRef[]>();

    // Unique slugs across the batch for a single resolution call.
    const uniqueNames = [...new Set(results.flatMap(r => r.topics))];
    if (uniqueNames.length === 0) {
      return byIndex;
    }

    let refByName = new Map<string, ClassificationTopicRef>();
    try {
      const refs = await topicService.resolveTopicRefs(uniqueNames.map(name => ({ name })));
      refByName = new Map(refs.map(ref => [ref.name, ref]));
    } catch (error) {
      logger.warn('[PostClassification] Topic registry resolution failed; storing name-only topicRefs', error);
    }

    for (const result of results) {
      byIndex.set(
        result.postIndex,
        result.topics.map(name => refByName.get(name) ?? { name }),
      );
    }
    return byIndex;
  }

  /** Persist a retry/expire update for every post in a wholesale-failed batch. */
  private async recordFailures(posts: QueueDoc[]): Promise<void> {
    const now = new Date();
    const bulkOps: AnyBulkWriteOperation<IPost>[] = posts.map(post => this.failureUpdateOp(post, now));
    if (bulkOps.length > 0) {
      await Post.bulkWrite(bulkOps, { ordered: false });
    }
  }

  /**
   * Build a single failure update: increment the attempt counter and flip to
   * `failed` once the retry budget is exhausted, otherwise leave it `pending` so
   * the next cycle retries it.
   */
  private failureUpdateOp(post: QueueDoc, now: Date): AnyBulkWriteOperation<IPost> {
    const nextAttempts = this.attemptsOf(post) + 1;
    const exhausted = nextAttempts >= this.MAX_ATTEMPTS;
    return {
      updateOne: {
        filter: { _id: post._id },
        update: {
          $set: {
            'postClassification.attempts': nextAttempts,
            'postClassification.status': exhausted ? 'failed' : 'pending',
            ...(exhausted ? { 'postClassification.classifiedAt': now } : {}),
          },
        },
      },
    };
  }

  private attemptsOf(post: QueueDoc): number {
    return post.postClassification?.attempts ?? 0;
  }

  /** Clamp every score into the 0..1 range as a defensive guard post-validation. */
  private normalizeScores(scores: PostClassificationScores): PostClassificationScores {
    const clamp = (n: number): number => Math.min(1, Math.max(0, n));
    return {
      toxicity: clamp(scores.toxicity),
      constructiveness: clamp(scores.constructiveness),
      spam: clamp(scores.spam),
      quality: clamp(scores.quality),
      controversy: clamp(scores.controversy),
      negativity: clamp(scores.negativity),
    };
  }
}

export const postClassificationService = new PostClassificationService();
