import UserBehavior, { IUserBehavior } from '../models/UserBehavior';
import { Post } from '../models/Post';
import Like from '../models/Like';
import Bookmark from '../models/Bookmark';
import mongoose, { HydratedDocument } from 'mongoose';
import { MtnConfig, isVideoSurface } from '@mention/shared-types';
import { logger } from '../utils/logger';

/**
 * Optional originating-surface context for an interaction. `surface` is the
 * feed-descriptor string the engagement happened on (e.g. `videos`, `for_you`,
 * `author|<id>`, `hashtag|<tag>`). Used for SURFACE-AWARE attribution; absent →
 * normal full attribution (backward compatible).
 */
export interface InteractionContext {
  surface?: string;
}

/**
 * The (lean) post fields {@link UserPreferenceService.recordInteraction} reads
 * when attributing an interaction. A structural subset of the `Post` document so
 * a lean query result is assignable without coupling to the full Mongoose
 * `Document` type. `postClassification` is kept loosely typed to match
 * {@link UserPreferenceService['getCanonicalTopics']}'s tolerant reader.
 */
interface InteractionPost {
  oxyUserId?: string;
  type?: string;
  language?: string;
  hashtags?: string[];
  postClassification?: { topicRefs?: unknown; topics?: unknown; region?: unknown };
}

/**
 * Extract the originating feed surface from a write-request body for
 * SURFACE-AWARE attribution. The frontend sends it as `source` (preferred) or
 * `feedContext`; either is the feed-descriptor string (e.g. `videos`, `for_you`,
 * `author|<id>`). Returns `undefined` when absent/blank so attribution falls
 * back to the normal full-weight path. Accepts an arbitrary body object so any
 * controller can call it without importing a request type.
 */
export function readInteractionSurface(
  body: { source?: unknown; feedContext?: unknown } | undefined | null,
): string | undefined {
  const raw = typeof body?.source === 'string'
    ? body.source
    : typeof body?.feedContext === 'string'
      ? body.feedContext
      : undefined;
  const trimmed = raw?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

/**
 * UserPreferenceService - Learns user preferences from behavior
 * Similar to how Twitter/Facebook infers user interests
 *
 * Updates user behavior model based on:
 * - Likes, boosts, comments, saves
 * - Time spent viewing posts
 * - Post types interacted with
 * - Topics/hashtags engaged with
 * - Authors interacted with
 */
export class UserPreferenceService {
  // The accumulators (preferredAuthors weight/decay, top-N sort+slice, recency
  // factors, multiplicative skip-decay) are stateful and order-dependent, so the
  // write is a load-modify-`.save()` under Mongoose optimistic concurrency (`__v`).
  // Feed-impression telemetry fires many concurrent interactions per user, so two
  // saves can collide on `__v` (`VersionError`). When that happens we re-read the
  // freshest document and re-apply the SAME mutation — the accumulators are
  // commutative-enough that re-applying against the winning revision yields the
  // correct end state, and the flood of `VersionError` logs/wasted writes is gone.
  // Bounded so a pathological hot user can never spin unboundedly.
  private readonly MAX_VERSION_CONFLICT_RETRIES = 5;
  // MongoDB duplicate-key error code, raised when two concurrent FIRST
  // interactions both insert a fresh UserBehavior for the same `oxyUserId`.
  private readonly DUPLICATE_KEY_ERROR_CODE = 11000;

  // Learning weights (how much each interaction affects preferences)
  private readonly LEARNING_WEIGHTS = {
    like: 1.0,
    boost: 2.0,
    comment: 2.5,
    save: 1.5,
    share: 1.8,
    view: 0.2,
    skip: -0.5,
    hide: -2.0,
    mute: -3.0,
    block: -5.0
  };

  /**
   * Update user behavior based on interaction.
   *
   * SURFACE-AWARE: when `context.surface` indicates a video-first feed (reels),
   * AUTHOR affinity is dampened and CONTENT (post-type + topic) affinity is
   * slightly amplified — a reels like means "I like this video content", not
   * "follow this author". Omitting `context` preserves full attribution.
   *
   * @param userId - Oxy user ID (from req.user?.id)
   * @param postId - Post ID
   * @param interactionType - Type of interaction
   * @param context - Optional originating-surface context (feed descriptor)
   */
  async recordInteraction(
    userId: string, // Oxy user ID
    postId: string,
    interactionType: 'like' | 'boost' | 'comment' | 'save' | 'share' | 'view' | 'skip' | 'hide' | 'mute' | 'block',
    context?: InteractionContext
  ): Promise<void> {
    try {
      logger.debug(`[UserPreference] Recording ${interactionType} interaction for user ${userId}, post ${postId}`);

      const post = await Post.findById(postId).lean();
      if (!post) {
        logger.warn(`[UserPreference] Post ${postId} not found, skipping interaction recording`);
        return;
      }

      // Apply the load-modify-save under a bounded retry loop so concurrent
      // interactions for the same user (impression telemetry) re-read and
      // re-apply on a write race instead of flooding error logs. Two races are
      // possible: a `__v` `VersionError` on the versioned update of an existing
      // document, and a duplicate-key error (`E11000` on the unique `oxyUserId`)
      // when two FIRST interactions both insert a fresh document. Both resolve by
      // re-reading the freshest revision and re-applying the same mutation.
      for (let attempt = 0; ; attempt++) {
        try {
          await this.applyInteraction(userId, post, interactionType, context);
          logger.debug(`[UserPreference] Successfully saved UserBehavior for user ${userId}`);
          return;
        } catch (error) {
          if (this.isConcurrentWriteConflict(error) && attempt < this.MAX_VERSION_CONFLICT_RETRIES) {
            logger.debug(
              `[UserPreference] Concurrent write conflict saving UserBehavior for user ${userId} (attempt ${attempt + 1}), retrying`,
            );
            continue;
          }
          throw error;
        }
      }
    } catch (error) {
      logger.error(`[UserPreference] Error recording interaction for user ${userId}, post ${postId}:`, error);
      // Re-throw to see full error stack
      throw error;
    }
  }

  /**
   * One load-modify-`.save()` pass for {@link recordInteraction}. Re-reads the
   * current `UserBehavior` document (so a retry applies against the freshest
   * revision), applies the full accumulator mutation, and persists it. Extracted
   * so the retry loop can re-run it verbatim on a `VersionError`. Behavior is
   * identical to the previous inline body — only the read+mutate+save is now
   * encapsulated so it can be re-attempted.
   */
  private async applyInteraction(
    userId: string,
    post: InteractionPost,
    interactionType: 'like' | 'boost' | 'comment' | 'save' | 'share' | 'view' | 'skip' | 'hide' | 'mute' | 'block',
    context?: InteractionContext,
  ): Promise<void> {
    // userId is an Oxy user ID, query UserBehavior using oxyUserId field
    let userBehavior = await UserBehavior.findOne({ oxyUserId: userId });

    if (!userBehavior) {
      logger.debug(`[UserPreference] Creating new UserBehavior record for user ${userId}`);
      userBehavior = new UserBehavior({
        oxyUserId: userId,
        preferredAuthors: [],
        preferredTopics: [],
        preferredPostTypes: {
          text: 0,
          image: 0,
          video: 0,
          poll: 0
        },
        activeHours: [],
        preferredLanguages: [],
        preferredRegions: []
      });
    }

    const weight = this.LEARNING_WEIGHTS[interactionType] || 0;
    // A negative weight is a NEGATIVE signal (e.g. `skip`): it must not be
    // allowed to look like positive engagement. Positive-only accumulators
    // (author interaction count, post-type preference, active hours) are
    // skipped for negative signals; the negative effect is applied explicitly.
    const isPositiveSignal = weight > 0;

    // SURFACE-AWARE attribution split. On a video-first surface (reels), an
    // engagement is about the CONTENT, not the author: dampen author affinity,
    // (slightly) amplify content (post-type/topic) affinity. Off video surfaces
    // both factors are 1.0 → identical to the prior behavior.
    const ctx = MtnConfig.preferences.engagementContext;
    const fromVideoSurface = isVideoSurface(context?.surface);
    // Author affinity is DAMPENED on video surfaces; this factor scales the
    // normalized relationship weight (see updateAuthorPreference) rather than
    // the raw input weight, because the relationship weight is derived from the
    // per-type interaction COUNTS, not from the input weight — scaling the input
    // alone would have no effect on the stored author weight.
    const authorAffinityFactor = fromVideoSurface ? ctx.videoSurfaceAuthorAffinityFactor : 1;
    const contentWeight = weight * (fromVideoSurface ? ctx.videoSurfaceContentBoost : 1);

    // Update author preference (positive signals strengthen the relationship).
    // Dampened on video surfaces so reels likes barely move "follow this author".
    if (post.oxyUserId && isPositiveSignal) {
      this.updateAuthorPreference(
        userBehavior,
        post.oxyUserId,
        interactionType,
        weight,
        authorAffinityFactor
      );
    }

    // Update topic preferences (positive signals only — skipping a topic must
    // not increase interest in it). Uses the content weight (amplified on video).
    if (isPositiveSignal && post.hashtags && post.hashtags.length > 0) {
      for (const hashtag of post.hashtags) {
        this.updateTopicPreference(
          userBehavior,
          hashtag.toLowerCase(),
          contentWeight
        );
      }
    }

    // Update topic preferences from classified topics (richer signal). Prefer
    // the canonical `postClassification.topicRefs` (registry-linked), falling
    // back to `postClassification.topics`. Canonical refs may carry no relevance
    // (AI topics are slug-only), so an absent relevance scales by the full
    // content weight (relevance factor 1) rather than zeroing the signal.
    if (isPositiveSignal) {
      for (const topic of this.getCanonicalTopics(post)) {
        if (typeof topic.name !== 'string' || topic.name.length === 0) continue;
        const relevanceFactor =
          typeof topic.relevance === 'number' ? topic.relevance / 10 : 1;
        this.updateTopicPreference(
          userBehavior,
          topic.name.toLowerCase(),
          contentWeight * relevanceFactor,
          topic.topicId,
        );
      }
    }

    // Update post type preference (positive signals only — a skipped post type
    // should not be promoted just because it was scrolled past). Uses the
    // content weight so a reels like reinforces "I like video content".
    if (isPositiveSignal) {
      const postType = (post.type || 'text').toLowerCase() as keyof typeof userBehavior.preferredPostTypes;
      if (postType in userBehavior.preferredPostTypes) {
        userBehavior.preferredPostTypes[postType] =
          (userBehavior.preferredPostTypes[postType] || 0) + contentWeight;
        // Mark nested object as modified
        userBehavior.markModified('preferredPostTypes');
      }
    }

    // Record active hour for any engagement (including a genuine view) — it
    // reflects WHEN the user is on the app, independent of sentiment. A pure
    // skip still means the user was active, so we record it too.
    const hour = new Date().getHours();
    if (!userBehavior.activeHours.includes(hour)) {
      userBehavior.activeHours.push(hour);
      // Keep only last 168 hours (1 week) of activity
      userBehavior.activeHours = userBehavior.activeHours.slice(-168);
      // Mark array as modified
      userBehavior.markModified('activeHours');
    }

    // Update language preference
    if (post.language && !userBehavior.preferredLanguages.includes(post.language)) {
      userBehavior.preferredLanguages.push(post.language);
      // Mark array as modified
      userBehavior.markModified('preferredLanguages');
    }

    // Update REGION affinity (positive signals only — a skip must not increase
    // interest in a region). Region is a CONTENT-origin signal, so it uses the
    // content weight (amplified on video surfaces) like topics/post-type. It is
    // best-effort and frequently absent — `postClassification.region` is itself
    // derived only from a federated instance domain or author locale, never from
    // post text — so this no-ops for most native posts. When present, the
    // dominant region accrues a stable count (read via `getTopRegion`).
    if (isPositiveSignal) {
      const region = post.postClassification?.region;
      if (typeof region === 'string' && region.length > 0) {
        this.updateRegionPreference(userBehavior, region, contentWeight);
      }
    }

    // Handle hard negative signals (hide/mute/block) — author/topic suppression.
    if (interactionType === 'hide' || interactionType === 'mute' || interactionType === 'block') {
      this.handleNegativeSignal(userBehavior, post, interactionType);
    }

    // Handle the soft negative signal (skip): the viewer scrolled past quickly.
    // This is NOT a suppression — it only nudges down an existing author
    // preference weight so a repeatedly-skipped author gradually loses its
    // boost. It never creates a preference entry or hides the author.
    if (interactionType === 'skip' && post.oxyUserId) {
      this.decayAuthorPreference(userBehavior, post.oxyUserId, Math.abs(weight));
    }

    userBehavior.lastUpdated = new Date();

    await userBehavior.save();
  }

  /**
   * True when an error from {@link applyInteraction}'s `.save()` is a retryable
   * concurrent-write race: a Mongoose optimistic-concurrency `VersionError` on
   * an existing document, or a MongoDB duplicate-key error (`E11000`) from two
   * concurrent first-interaction inserts on the unique `oxyUserId`. Both are
   * resolved by re-reading and re-applying.
   */
  private isConcurrentWriteConflict(error: unknown): boolean {
    if (error instanceof mongoose.Error.VersionError) {
      return true;
    }
    return (
      error instanceof mongoose.mongo.MongoServerError &&
      error.code === this.DUPLICATE_KEY_ERROR_CODE
    );
  }

  /**
   * Update author relationship strength
   * Note: This is synchronous as it only modifies objects in memory
   */
  private updateAuthorPreference(
    userBehavior: HydratedDocument<IUserBehavior>,
    authorId: string,
    interactionType: string,
    weight: number,
    // SURFACE-AWARE dampener applied to the FINAL normalized relationship weight.
    // 1 = no dampening (default / non-video surface); <1 = a video-surface
    // engagement contributes proportionally less toward "follow this author".
    authorAffinityFactor: number = 1
  ): void {
    let authorPref = userBehavior.preferredAuthors.find(
      (a) => a.authorId === authorId
    );

    if (!authorPref) {
      authorPref = {
        authorId,
        interactionCount: 0,
        lastInteractionAt: new Date(),
        interactionTypes: {
          likes: 0,
          boosts: 0,
          comments: 0,
          saves: 0,
          shares: 0
        },
        weight: 0
      };
      userBehavior.preferredAuthors.push(authorPref);
    }

    // Update interaction count
    authorPref.interactionCount += Math.abs(weight);
    authorPref.lastInteractionAt = new Date();

    // Update specific interaction type
    if (interactionType === 'like') {
      authorPref.interactionTypes.likes += 1;
    }
    if (interactionType === 'boost') {
      authorPref.interactionTypes.boosts += 1;
    }
    if (interactionType === 'comment') {
      authorPref.interactionTypes.comments += 1;
    }
    if (interactionType === 'save') {
      authorPref.interactionTypes.saves += 1;
    }
    if (interactionType === 'share') {
      authorPref.interactionTypes.shares += 1;
    }

    // Calculate relationship weight (0-1 scale)
    // Based on interaction count and recency
    const totalInteractions =
      authorPref.interactionTypes.likes +
      authorPref.interactionTypes.boosts * 2 +
      authorPref.interactionTypes.comments * 2 +
      authorPref.interactionTypes.saves * 1.5 +
      authorPref.interactionTypes.shares * 2;

    const daysSinceLastInteraction =
      (Date.now() - authorPref.lastInteractionAt.getTime()) / (1000 * 60 * 60 * 24);

    // Weight decays over time, but is normalized to 0-1. The surface-aware
    // dampener (authorAffinityFactor) scales it DOWN for video-surface
    // engagements so a reels like barely moves "follow this author".
    const recencyFactor = Math.max(0, 1 - daysSinceLastInteraction / 30); // Decay over 30 days
    authorPref.weight = Math.min(1, (totalInteractions / 100) * recencyFactor * authorAffinityFactor);

    // Keep only top 100 authors by weight
    userBehavior.preferredAuthors.sort((a, b) => b.weight - a.weight);
    if (userBehavior.preferredAuthors.length > 100) {
      userBehavior.preferredAuthors = userBehavior.preferredAuthors.slice(0, 100);
    }

    // Mark the array as modified so Mongoose saves the changes
    userBehavior.markModified('preferredAuthors');
  }

  /**
   * Soft-negative author signal: nudge down an EXISTING author preference weight
   * (e.g. on a `skip`). Does nothing if the viewer has no preference entry for
   * the author — a skip should never create or hide an author, only erode an
   * accumulated boost so a repeatedly-skipped author drifts back toward neutral.
   * Note: synchronous — only modifies in-memory objects.
   */
  private decayAuthorPreference(
    userBehavior: HydratedDocument<IUserBehavior>,
    authorId: string,
    magnitude: number
  ): void {
    const authorPref = userBehavior.preferredAuthors.find(
      (a) => a.authorId === authorId
    );
    if (!authorPref) {
      return; // No existing relationship — nothing to erode.
    }

    // Reduce the weight proportionally to the skip magnitude, clamped to >= 0.
    // 0.1 keeps a single skip gentle; sustained skipping compounds toward 0.
    const decayFactor = Math.max(0, 1 - magnitude * 0.1);
    authorPref.weight = Math.max(0, authorPref.weight * decayFactor);
    authorPref.lastInteractionAt = new Date();

    userBehavior.markModified('preferredAuthors');
  }

  /**
   * The canonical classified topics for a post, PREFERRING the registry-linked
   * `postClassification.topicRefs` and FALLING BACK to the slug-only
   * `postClassification.topics` (each slug normalized to `{ name }`). Returns `[]`
   * when neither exists so a topic-less post contributes no topic preference. Each
   * entry exposes `name`; only `topicRefs` carries the optional `topicId` and
   * `relevance` (the slug list is name-only, so it learns preferences by name).
   */
  private getCanonicalTopics(
    post: { postClassification?: { topicRefs?: unknown; topics?: unknown } },
  ): Array<{ name?: unknown; topicId?: string; relevance?: number }> {
    const refs = post.postClassification?.topicRefs;
    if (Array.isArray(refs) && refs.length > 0) {
      return refs;
    }
    const topics = post.postClassification?.topics;
    if (Array.isArray(topics) && topics.length > 0) {
      return topics.map((name: unknown) => ({ name }));
    }
    return [];
  }

  /**
   * Update topic preference
   * Note: This is synchronous as it only modifies objects in memory
   */
  private updateTopicPreference(
    userBehavior: HydratedDocument<IUserBehavior>,
    topic: string,
    weight: number,
    topicId?: string,
  ): void {
    let topicPref = userBehavior.preferredTopics.find(
      (t) => t.topic === topic
    );

    if (!topicPref) {
      topicPref = {
        topic,
        interactionCount: 0,
        lastInteractionAt: new Date(),
        weight: 0,
        ...(topicId ? { topicId } : {}),
      };
      userBehavior.preferredTopics.push(topicPref);
    } else if (topicId && !topicPref.topicId) {
      // Backfill topicId on existing preference entries
      topicPref.topicId = topicId;
    }

    topicPref.interactionCount += Math.abs(weight);
    topicPref.lastInteractionAt = new Date();

    // Calculate topic weight
    const daysSinceLastInteraction =
      (Date.now() - topicPref.lastInteractionAt.getTime()) / (1000 * 60 * 60 * 24);
    const recencyFactor = Math.max(0, 1 - daysSinceLastInteraction / 30);
    topicPref.weight = Math.min(1, (topicPref.interactionCount / 50) * recencyFactor);

    // Keep only top 200 topics
    userBehavior.preferredTopics.sort((a, b) => b.weight - a.weight);
    if (userBehavior.preferredTopics.length > 200) {
      userBehavior.preferredTopics = userBehavior.preferredTopics.slice(0, 200);
    }
  }

  /**
   * Accumulate REGION affinity as a counted multiset entry. Unlike author/topic
   * preferences this is a simple recency-stamped count (no normalized 0–1
   * weight): the consumer only needs the DOMINANT region, and a raw count picks
   * a stable winner without thrashing on every engagement. Sorted by count so
   * `getTopRegion` reads index 0; kept bounded so a viewer who roams many
   * instances can't grow the array unboundedly.
   * Note: synchronous — only modifies in-memory objects.
   */
  private updateRegionPreference(
    userBehavior: HydratedDocument<IUserBehavior>,
    region: string,
    weight: number,
  ): void {
    if (!userBehavior.preferredRegions) {
      userBehavior.preferredRegions = [];
    }
    let regionPref = userBehavior.preferredRegions.find(
      (r) => r.region === region,
    );

    if (!regionPref) {
      regionPref = { region, count: 0, lastInteractionAt: new Date() };
      userBehavior.preferredRegions.push(regionPref);
    }

    regionPref.count += Math.abs(weight);
    regionPref.lastInteractionAt = new Date();

    // Most-engaged region first; bound the list (regions are a small, coarse
    // space — this cap is just a safety ceiling, not an expected trim point).
    userBehavior.preferredRegions.sort((a, b) => b.count - a.count);
    if (userBehavior.preferredRegions.length > MtnConfig.preferences.maxPreferredRegions) {
      userBehavior.preferredRegions = userBehavior.preferredRegions.slice(
        0,
        MtnConfig.preferences.maxPreferredRegions,
      );
    }

    userBehavior.markModified('preferredRegions');
  }

  /**
   * The viewer's DOMINANT learned region (the highest-count `preferredRegions`
   * entry), or `undefined` when the viewer has learned none. Best-effort and
   * often `undefined` because post region is itself sparse — callers must treat
   * a missing region as a no-op (never error, never empty a feed). Accepts the
   * lean behavior shape used across the feed pipeline.
   */
  getTopRegion(
    userBehavior: { preferredRegions?: Array<{ region?: string; count?: number }> } | null | undefined,
  ): string | undefined {
    const regions = userBehavior?.preferredRegions;
    if (!Array.isArray(regions) || regions.length === 0) return undefined;
    let top: { region?: string; count?: number } | undefined;
    for (const entry of regions) {
      if (typeof entry?.region !== 'string' || entry.region.length === 0) continue;
      if (!top || (entry.count ?? 0) > (top.count ?? 0)) top = entry;
    }
    return top?.region;
  }

  /**
   * Handle negative signals (hide, mute, block)
   * Note: This is synchronous as it only modifies objects in memory
   */
  private handleNegativeSignal(
    userBehavior: HydratedDocument<IUserBehavior>,
    post: InteractionPost,
    interactionType: string
  ): void {
    const authorId = post.oxyUserId ?? '';

    if (interactionType === 'hide') {
      if (!userBehavior.hiddenAuthors.includes(authorId)) {
        userBehavior.hiddenAuthors.push(authorId);
        userBehavior.markModified('hiddenAuthors');
      }
    }

    if (interactionType === 'mute') {
      if (!userBehavior.mutedAuthors.includes(authorId)) {
        userBehavior.mutedAuthors.push(authorId);
        userBehavior.markModified('mutedAuthors');
      }
    }

    if (interactionType === 'block') {
      if (!userBehavior.blockedAuthors.includes(authorId)) {
        userBehavior.blockedAuthors.push(authorId);
        userBehavior.markModified('blockedAuthors');
      }
    }

    // Remove from preferred authors if present
    userBehavior.preferredAuthors = userBehavior.preferredAuthors.filter(
      (a) => a.authorId !== authorId
    );
    if (userBehavior.preferredAuthors.length > 0) {
      userBehavior.markModified('preferredAuthors');
    }

    // Handle hidden topics
    if (interactionType === 'hide' && post.hashtags && post.hashtags.length > 0) {
      for (const tag of post.hashtags) {
        if (!userBehavior.hiddenTopics.includes(tag.toLowerCase())) {
          userBehavior.hiddenTopics.push(tag.toLowerCase());
        }
      }
      if (userBehavior.hiddenTopics.length > 0) {
        userBehavior.markModified('hiddenTopics');
      }
    }
  }

  /**
   * Batch update user preferences from historical data
   * Useful for initial setup or periodic recalculation
   */
  async batchUpdatePreferences(userId: string): Promise<void> {
    try {
      const userBehavior = await UserBehavior.findOne({ oxyUserId: userId });
      if (!userBehavior) {
        return;
      }

      // Get all user's likes
      const likes = await Like.find({ userId }).lean();
      for (const like of likes) {
        await this.recordInteraction(userId, like.postId.toString(), 'like');
      }

      // Get all user's bookmarks
      const bookmarks = await Bookmark.find({ userId }).lean();
      for (const bookmark of bookmarks) {
        await this.recordInteraction(userId, bookmark.postId.toString(), 'save');
      }

      // Get all user's posts (to infer preferences)
      const userPosts = await Post.find({ oxyUserId: userId }).lean();
      for (const post of userPosts) {
        // User creating posts with certain hashtags = interest
        if (post.hashtags && post.hashtags.length > 0) {
          for (const hashtag of post.hashtags) {
            this.updateTopicPreference(
              userBehavior,
              hashtag.toLowerCase(),
              0.5 // Lower weight for creation vs interaction
            );
          }
        }
      }
    } catch (error) {
      logger.error(`[UserPreference] Error batch updating preferences for user ${userId}:`, error);
    }
  }

  /**
   * Get user behavior data (lean). `null` when the viewer has none yet.
   */
  async getUserBehavior(userId: string): Promise<IUserBehavior | null> {
    return await UserBehavior.findOne({ oxyUserId: userId }).lean<IUserBehavior>();
  }

  /**
   * Track time spent viewing post (for engagement metrics)
   */
  async recordViewTime(
    userId: string,
    postId: string,
    viewTimeSeconds: number
  ): Promise<void> {
    try {
      const userBehavior = await UserBehavior.findOne({ oxyUserId: userId });
      if (!userBehavior) {
        return;
      }

      // Update average engagement time (exponential moving average)
      const alpha = 0.1; // Learning rate
      userBehavior.averageEngagementTime =
        userBehavior.averageEngagementTime * (1 - alpha) + viewTimeSeconds * alpha;

      // If view time is very short, it's likely a skip
      if (viewTimeSeconds < 2) {
        await this.recordInteraction(userId, postId, 'skip');
      }

      await userBehavior.save();
    } catch (error) {
      logger.error(`[UserPreference] Error recording view time for user ${userId}:`, error);
    }
  }
}

export const userPreferenceService = new UserPreferenceService();
