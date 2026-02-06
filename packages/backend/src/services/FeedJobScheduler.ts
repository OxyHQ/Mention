import { feedCacheService } from './FeedCacheService';
import { userPreferenceService } from './UserPreferenceService';
import { Post } from '../models/Post';
import { logger } from '../utils/logger';

// Optional Bull import (for job queue)
let Bull: any = null;
try {
  Bull = require('bull');
} catch (error) {
  // Bull not installed, will use fallback interval-based processing
  logger.debug('Bull queue not available, using interval-based job processing');
}

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

interface ActiveUser {
  userId: string;
  lastActivity: Date;
  activityCount: number;
}

export class FeedJobScheduler {
  private intervals: Map<string, NodeJS.Timeout> = new Map();
  private isRunning: boolean = false;
  private feedQueue: any = null; // Bull.Queue | null
  
  // Track active users (last 24 hours)
  // In production, this would be stored in Redis or a database
  private activeUsers: Map<string, ActiveUser> = new Map();
  private readonly ACTIVE_USER_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

  constructor() {
    // Initialize Bull queue for feed precomputation jobs (if available)
    // Use Redis connection string from environment
    if (Bull) {
      const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
      try {
        this.feedQueue = new Bull('feed-precomputation', redisUrl, {
          defaultJobOptions: {
            removeOnComplete: 100, // Keep last 100 completed jobs
            removeOnFail: 500, // Keep last 500 failed jobs
            attempts: 3,
            backoff: {
              type: 'exponential',
              delay: 2000
            }
          }
        });
        
        // Process feed precomputation jobs
        this.feedQueue.process('precompute-feed', async (job: any) => {
          const { userId, feedType, limit } = job.data;
          logger.debug(`Processing feed precomputation job for user ${userId}, feed type ${feedType}`);
          await feedCacheService.precomputeFeed(userId, feedType, limit || 50);
        });
      } catch (error) {
        logger.warn('Failed to initialize Bull queue, using interval-based jobs only:', error);
      }
    }
  }

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
        logger.error('Error in precompute feeds job:', err);
      });
    }, 15 * 60 * 1000) as unknown as NodeJS.Timeout); // 15 minutes

    // Update user preferences every hour
    this.intervals.set('updatePreferences', setInterval(() => {
      this.updateUserPreferences().catch(err => {
        logger.error('Error in update preferences job:', err);
      });
    }, 60 * 60 * 1000) as unknown as NodeJS.Timeout); // 1 hour

    // Clean expired L1 cache entries every 5 minutes
    this.intervals.set('cleanCache', setInterval(() => {
      feedCacheService.evictExpiredEntries();
    }, 5 * 60 * 1000) as unknown as NodeJS.Timeout); // 5 minutes

    // Clean up old active user records every hour
    this.intervals.set('cleanActiveUsers', setInterval(() => {
      this.cleanupActiveUsers();
    }, 60 * 60 * 1000) as unknown as NodeJS.Timeout); // 1 hour

    logger.info('Feed job scheduler started');
  }

  /**
   * Stop background jobs
   */
  stop(): void {
    this.intervals.forEach(interval => clearInterval(interval));
    this.intervals.clear();
    this.isRunning = false;
    
    if (this.feedQueue) {
      this.feedQueue.close();
    }
    
    logger.info('Feed job scheduler stopped');
  }

  /**
   * Record user activity (called when user requests feed)
   */
  recordUserActivity(userId: string): void {
    const now = Date.now();
    const existing = this.activeUsers.get(userId);
    
    if (existing) {
      existing.lastActivity = new Date(now);
      existing.activityCount += 1;
    } else {
      this.activeUsers.set(userId, {
        userId,
        lastActivity: new Date(now),
        activityCount: 1
      });
    }
  }

  /**
   * Get active users (users who were active in last 24 hours)
   */
  private getActiveUsers(): string[] {
    const now = Date.now();
    const active: string[] = [];
    
    for (const [userId, user] of this.activeUsers.entries()) {
      const timeSinceActivity = now - user.lastActivity.getTime();
      if (timeSinceActivity < this.ACTIVE_USER_TTL_MS) {
        active.push(userId);
      }
    }
    
    // Sort by activity count (most active first)
    return active.sort((a, b) => {
      const userA = this.activeUsers.get(a);
      const userB = this.activeUsers.get(b);
      return (userB?.activityCount || 0) - (userA?.activityCount || 0);
    });
  }

  /**
   * Clean up old active user records
   */
  private cleanupActiveUsers(): void {
    const now = Date.now();
    let cleaned = 0;
    
    for (const [userId, user] of this.activeUsers.entries()) {
      const timeSinceActivity = now - user.lastActivity.getTime();
      if (timeSinceActivity >= this.ACTIVE_USER_TTL_MS) {
        this.activeUsers.delete(userId);
        cleaned++;
      }
    }
    
    if (cleaned > 0) {
      logger.debug(`Cleaned up ${cleaned} inactive user records`);
    }
  }

  /**
   * Precompute feeds for active users
   * Active users are those who logged in or requested feeds within last 24 hours
   */
  private async precomputeActiveUserFeeds(): Promise<void> {
    try {
      const activeUsers = this.getActiveUsers();
      
      if (activeUsers.length === 0) {
        logger.debug('No active users to precompute feeds for');
        return;
      }
      
      // Precompute for top 10% most active users (or top 100, whichever is smaller)
      const topUsers = activeUsers.slice(0, Math.min(100, Math.ceil(activeUsers.length * 0.1)));
      
      logger.info(`Precomputing feeds for ${topUsers.length} active users (out of ${activeUsers.length} total)`);
      
      // Use Bull queue if available, otherwise process sequentially
      if (this.feedQueue) {
        // Add jobs to queue for parallel processing
        const jobs = [];
        for (const userId of topUsers) {
          for (const feedType of ['for_you', 'following', 'explore'] as const) {
            jobs.push(
              this.feedQueue.add('precompute-feed', {
                userId,
                feedType,
                limit: 50
              }, {
                priority: this.getUserPriority(userId)
              })
            );
          }
        }
        await Promise.allSettled(jobs);
        logger.info(`Queued ${jobs.length} feed precomputation jobs`);
      } else {
        // Fallback: process sequentially (slower but works without Bull)
        for (const userId of topUsers) {
          try {
            await Promise.all([
              feedCacheService.precomputeFeed(userId, 'for_you', 50),
              feedCacheService.precomputeFeed(userId, 'following', 50),
              feedCacheService.precomputeFeed(userId, 'explore', 50)
            ]);
          } catch (error) {
            logger.warn(`Failed to precompute feeds for user ${userId}:`, error);
          }
        }
        logger.info(`Precomputed feeds for ${topUsers.length} users`);
      }
    } catch (error) {
      logger.error('Error precomputing feeds:', error);
    }
  }

  /**
   * Get priority for user (higher activity = higher priority)
   */
  private getUserPriority(userId: string): number {
    const user = this.activeUsers.get(userId);
    if (!user) return 0;
    
    // Priority based on activity count (1-100)
    return Math.min(100, user.activityCount);
  }

  /**
   * Update user preferences from recent activity
   */
  private async updateUserPreferences(): Promise<void> {
    try {
      logger.debug('Updating user preferences from recent activity...');
      
      // Get active users
      const activeUsers = this.getActiveUsers();
      
      // Batch update preferences for active users
      const updatePromises = activeUsers.slice(0, 50).map(userId => 
        userPreferenceService.batchUpdatePreferences(userId)
          .catch(error => {
            logger.warn(`Failed to update preferences for user ${userId}:`, error);
          })
      );
      
      await Promise.allSettled(updatePromises);
      logger.info(`Updated preferences for ${activeUsers.length} active users`);
    } catch (error) {
      logger.error('Error updating user preferences:', error);
    }
  }

  /**
   * Manually trigger feed precomputation for a user
   * Useful when user logs in or requests feed
   */
  async precomputeUserFeeds(userId: string): Promise<void> {
    try {
      // Record activity
      this.recordUserActivity(userId);
      
      // Precompute feeds
      await Promise.all([
        feedCacheService.precomputeFeed(userId, 'for_you', 50),
        feedCacheService.precomputeFeed(userId, 'following', 50),
        feedCacheService.precomputeFeed(userId, 'explore', 50)
      ]);
    } catch (error) {
      logger.error(`Error precomputing feeds for user ${userId}:`, error);
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
      logger.error(`Error updating preferences for user ${userId}:`, error);
    }
  }

  /**
   * Get statistics about active users
   */
  getActiveUserStats(): { total: number; topUsers: Array<{ userId: string; activityCount: number }> } {
    const activeUsers = this.getActiveUsers();
    const topUsers = activeUsers
      .slice(0, 10)
      .map(userId => {
        const user = this.activeUsers.get(userId);
        return {
          userId,
          activityCount: user?.activityCount || 0
        };
      });
    
    return {
      total: activeUsers.length,
      topUsers
    };
  }
}

export const feedJobScheduler = new FeedJobScheduler();
