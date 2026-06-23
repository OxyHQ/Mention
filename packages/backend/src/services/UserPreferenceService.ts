import UserBehavior from '../models/UserBehavior';
import { Post } from '../models/Post';
import Like from '../models/Like';
import Bookmark from '../models/Bookmark';
import mongoose from 'mongoose';
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
          preferredLanguages: []
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

      // Update topic preferences from AI-extracted topics (richer signal)
      if (isPositiveSignal && post.extracted?.topics && post.extracted.topics.length > 0) {
        for (const extractedTopic of post.extracted.topics) {
          this.updateTopicPreference(
            userBehavior,
            extractedTopic.name.toLowerCase(),
            contentWeight * (extractedTopic.relevance / 10), // Scale weight by relevance
            extractedTopic.topicId,
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
      logger.debug(`[UserPreference] Successfully saved UserBehavior for user ${userId}`);
    } catch (error) {
      logger.error(`[UserPreference] Error recording interaction for user ${userId}, post ${postId}:`, error);
      // Re-throw to see full error stack
      throw error;
    }
  }

  /**
   * Update author relationship strength
   * Note: This is synchronous as it only modifies objects in memory
   */
  private updateAuthorPreference(
    userBehavior: any,
    authorId: string,
    interactionType: string,
    weight: number,
    // SURFACE-AWARE dampener applied to the FINAL normalized relationship weight.
    // 1 = no dampening (default / non-video surface); <1 = a video-surface
    // engagement contributes proportionally less toward "follow this author".
    authorAffinityFactor: number = 1
  ): void {
    let authorPref = userBehavior.preferredAuthors.find(
      (a: any) => a.authorId === authorId
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
    userBehavior.preferredAuthors.sort((a: any, b: any) => b.weight - a.weight);
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
    userBehavior: any,
    authorId: string,
    magnitude: number
  ): void {
    const authorPref = userBehavior.preferredAuthors.find(
      (a: any) => a.authorId === authorId
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
   * Update topic preference
   * Note: This is synchronous as it only modifies objects in memory
   */
  private updateTopicPreference(
    userBehavior: any,
    topic: string,
    weight: number,
    topicId?: string,
  ): void {
    let topicPref = userBehavior.preferredTopics.find(
      (t: any) => t.topic === topic
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
    userBehavior.preferredTopics.sort((a: any, b: any) => b.weight - a.weight);
    if (userBehavior.preferredTopics.length > 200) {
      userBehavior.preferredTopics = userBehavior.preferredTopics.slice(0, 200);
    }
  }

  /**
   * Handle negative signals (hide, mute, block)
   * Note: This is synchronous as it only modifies objects in memory
   */
  private handleNegativeSignal(
    userBehavior: any,
    post: any,
    interactionType: string
  ): void {
    const authorId = post.oxyUserId;

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
      (a: any) => a.authorId !== authorId
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
   * Get user behavior data
   */
  async getUserBehavior(userId: string): Promise<any> {
    return await UserBehavior.findOne({ oxyUserId: userId }).lean();
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
