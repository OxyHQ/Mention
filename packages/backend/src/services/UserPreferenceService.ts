import UserBehavior from '../models/UserBehavior';
import { Post } from '../models/Post';
import Like from '../models/Like';
import Bookmark from '../models/Bookmark';
import mongoose from 'mongoose';
import { logger } from '../utils/logger';

/**
 * UserPreferenceService - Learns user preferences from behavior
 * Similar to how Twitter/Facebook infers user interests
 *
 * Updates user behavior model based on:
 * - Likes, reposts, comments, saves
 * - Time spent viewing posts
 * - Post types interacted with
 * - Topics/hashtags engaged with
 * - Authors interacted with
 */
export class UserPreferenceService {
  // Learning weights (how much each interaction affects preferences)
  private readonly LEARNING_WEIGHTS = {
    like: 1.0,
    repost: 2.0,
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
   * Update user behavior based on interaction
   *
   * @param userId - Oxy user ID (from req.user?.id)
   * @param postId - Post ID
   * @param interactionType - Type of interaction
   */
  async recordInteraction(
    userId: string, // Oxy user ID
    postId: string,
    interactionType: 'like' | 'repost' | 'comment' | 'save' | 'share' | 'view' | 'skip' | 'hide' | 'mute' | 'block'
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

      // Update author preference
      this.updateAuthorPreference(
        userBehavior,
        post.oxyUserId,
        interactionType,
        weight
      );

      // Update topic preferences
      if (post.hashtags && post.hashtags.length > 0) {
        for (const hashtag of post.hashtags) {
          this.updateTopicPreference(
            userBehavior,
            hashtag.toLowerCase(),
            weight
          );
        }
      }

      // Update post type preference
      const postType = (post.type || 'text').toLowerCase() as keyof typeof userBehavior.preferredPostTypes;
      if (postType in userBehavior.preferredPostTypes) {
        userBehavior.preferredPostTypes[postType] =
          (userBehavior.preferredPostTypes[postType] || 0) + Math.abs(weight);
      }
      // Mark nested object as modified
      userBehavior.markModified('preferredPostTypes');

      // Record active hour
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

      // Handle negative signals
      if (interactionType === 'hide' || interactionType === 'mute' || interactionType === 'block') {
        this.handleNegativeSignal(userBehavior, post, interactionType);
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
    weight: number
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
          reposts: 0,
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
    if (interactionType === 'repost') {
      authorPref.interactionTypes.reposts += 1;
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
      authorPref.interactionTypes.reposts * 2 +
      authorPref.interactionTypes.comments * 2 +
      authorPref.interactionTypes.saves * 1.5 +
      authorPref.interactionTypes.shares * 2;

    const daysSinceLastInteraction =
      (Date.now() - authorPref.lastInteractionAt.getTime()) / (1000 * 60 * 60 * 24);

    // Weight decays over time, but is normalized to 0-1
    const recencyFactor = Math.max(0, 1 - daysSinceLastInteraction / 30); // Decay over 30 days
    authorPref.weight = Math.min(1, (totalInteractions / 100) * recencyFactor);

    // Keep only top 100 authors by weight
    userBehavior.preferredAuthors.sort((a: any, b: any) => b.weight - a.weight);
    if (userBehavior.preferredAuthors.length > 100) {
      userBehavior.preferredAuthors = userBehavior.preferredAuthors.slice(0, 100);
    }

    // Mark the array as modified so Mongoose saves the changes
    userBehavior.markModified('preferredAuthors');
  }

  /**
   * Update topic preference
   * Note: This is synchronous as it only modifies objects in memory
   */
  private updateTopicPreference(
    userBehavior: any,
    topic: string,
    weight: number
  ): void {
    let topicPref = userBehavior.preferredTopics.find(
      (t: any) => t.topic === topic
    );

    if (!topicPref) {
      topicPref = {
        topic,
        interactionCount: 0,
        lastInteractionAt: new Date(),
        weight: 0
      };
      userBehavior.preferredTopics.push(topicPref);
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
