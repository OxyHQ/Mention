import { feedCacheService } from './FeedCacheService';
import { userPreferenceService } from './UserPreferenceService';

/**
 * FeedJobScheduler - Background jobs for feed computation
 * Similar to how Twitter/Facebook refresh feeds in the background
 * 
 * Jobs:
 * - Precompute feeds for active users
 * - Update user preferences from recent activity
 * - Refresh trending topics
 * - Clean old cache entries
 */

export class FeedJobScheduler {
  private intervals: Map<string, NodeJS.Timeout> = new Map();
  private isRunning: boolean = false;

  /**
   * Start background jobs
   */
  start(): void {
    if (this.isRunning) {
      return;
    }

    this.isRunning = true;

    // Precompute feeds for active users every 15 minutes
    this.intervals.set('precomputeFeeds', setInterval(() => {
      this.precomputeActiveUserFeeds().catch(err => {
        console.error('Error in precompute feeds job:', err);
      });
    }, 15 * 60 * 1000) as NodeJS.Timeout); // 15 minutes

    // Update user preferences every hour
    this.intervals.set('updatePreferences', setInterval(() => {
      this.updateUserPreferences().catch(err => {
        console.error('Error in update preferences job:', err);
      });
    }, 60 * 60 * 1000) as NodeJS.Timeout); // 1 hour

    // Clean cache every 5 minutes
    this.intervals.set('cleanCache', setInterval(() => {
      feedCacheService.getCacheStats(); // This triggers internal cleanup
    }, 5 * 60 * 1000) as NodeJS.Timeout); // 5 minutes

    console.log('Feed job scheduler started');
  }

  /**
   * Stop background jobs
   */
  stop(): void {
    this.intervals.forEach(interval => clearInterval(interval));
    this.intervals.clear();
    this.isRunning = false;
    console.log('Feed job scheduler stopped');
  }

  /**
   * Precompute feeds for active users
   * Active users are those who logged in within last 24 hours
   */
  private async precomputeActiveUserFeeds(): Promise<void> {
    try {
      // In a real implementation, you'd query active users from a session store
      // For now, we'll skip this as we don't have a session store
      // This is a placeholder that can be expanded
      
      console.log('Precomputing feeds for active users...');
      
      // Example: Get recent users from analytics or session store
      // const activeUsers = await getActiveUsers(last24Hours);
      // 
      // for (const userId of activeUsers) {
      //   await feedCacheService.precomputeFeed(userId, 'for_you', 50);
      //   await feedCacheService.precomputeFeed(userId, 'following', 50);
      // }
      
      console.log('Feed precomputation completed');
    } catch (error) {
      console.error('Error precomputing feeds:', error);
    }
  }

  /**
   * Update user preferences from recent activity
   */
  private async updateUserPreferences(): Promise<void> {
    try {
      console.log('Updating user preferences from recent activity...');
      
      // This would batch update preferences for users with recent activity
      // For now, preferences are updated in real-time when users interact
      
      // In a production system, you might:
      // 1. Find users with recent interactions
      // 2. Batch update their preference models
      // 3. Recompute relationship weights
      
      console.log('User preference update completed');
    } catch (error) {
      console.error('Error updating user preferences:', error);
    }
  }

  /**
   * Manually trigger feed precomputation for a user
   * Useful when user logs in or requests feed
   */
  async precomputeUserFeeds(userId: string): Promise<void> {
    try {
      await Promise.all([
        feedCacheService.precomputeFeed(userId, 'for_you', 50),
        feedCacheService.precomputeFeed(userId, 'following', 50),
        feedCacheService.precomputeFeed(userId, 'explore', 50)
      ]);
    } catch (error) {
      console.error(`Error precomputing feeds for user ${userId}:`, error);
    }
  }

  /**
   * Manually trigger preference update for a user
   * Useful after batch interactions
   */
  async updateUserPreferencesForUser(userId: string): Promise<void> {
    try {
      await userPreferenceService.batchUpdatePreferences(userId);
    } catch (error) {
      console.error(`Error updating preferences for user ${userId}:`, error);
    }
  }
}

export const feedJobScheduler = new FeedJobScheduler();

