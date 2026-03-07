import { feedCacheService } from './FeedCacheService';
import { userPreferenceService } from './UserPreferenceService';
import { Post } from '../models/Post';
import { logger } from '../utils/logger';
import { getRedisClient } from '../utils/redis';

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

// Redis key constants
const REDIS_ACTIVE_USERS_ZSET = 'feed:active_users';
const REDIS_ACTIVE_USERS_COUNTS = 'feed:active_users:counts';

// Configurable max for precomputation
const MAX_PRECOMPUTE_USERS = parseInt(process.env.MAX_PRECOMPUTE_USERS || '500', 10);

// 1 hour in seconds (for "hot" threshold)
const HOT_USER_THRESHOLD_MS = 60 * 60 * 1000;

export class FeedJobScheduler {
  private intervals: Map<string, NodeJS.Timeout> = new Map();
  private isRunning: boolean = false;
  private feedQueue: any = null; // Bull.Queue | null

  // Fallback in-memory Map used when Redis is unavailable
  private fallbackActiveUsers: Map<string, ActiveUser> = new Map();
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
      this.cleanupActiveUsers().catch(err => {
        logger.error('Error in cleanup active users job:', err);
      });
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
   * Record user activity (called when user requests feed).
   * Fire-and-forget: callers do not need to await.
   */
  async recordUserActivity(userId: string): Promise<void> {
    const now = Date.now();

    try {
      const client = getRedisClient();
      if (client.isReady) {
        // Update sorted set score (timestamp) and increment count
        await client.zAdd(REDIS_ACTIVE_USERS_ZSET, { score: now, value: userId });
        await client.hIncrBy(REDIS_ACTIVE_USERS_COUNTS, userId, 1);
        return;
      }
    } catch (error) {
      logger.debug('Redis unavailable for recordUserActivity, using in-memory fallback');
    }

    // Fallback: in-memory Map
    const existing = this.fallbackActiveUsers.get(userId);
    if (existing) {
      existing.lastActivity = new Date(now);
      existing.activityCount += 1;
    } else {
      this.fallbackActiveUsers.set(userId, {
        userId,
        lastActivity: new Date(now),
        activityCount: 1
      });
    }
  }

  /**
   * Get active users (users who were active in last 24 hours), sorted by activity count descending.
   * Returns { userId, activityCount, isHot } — isHot means active in last 1 hour.
   */
  private async getActiveUsers(): Promise<Array<{ userId: string; activityCount: number; isHot: boolean }>> {
    const now = Date.now();
    const cutoff = now - this.ACTIVE_USER_TTL_MS;
    const hotCutoff = now - HOT_USER_THRESHOLD_MS;

    try {
      const client = getRedisClient();
      if (client.isReady) {
        // Get all users active within TTL window
        const members = await client.zRangeByScore(
          REDIS_ACTIVE_USERS_ZSET,
          cutoff,
          now
        );

        if (members.length === 0) {
          return [];
        }

        // Fetch activity counts in one HMGET call
        const counts = await client.hmGet(REDIS_ACTIVE_USERS_COUNTS, members);

        // Fetch timestamps to determine hot vs. warm
        const timestamps = await client.zmScore(REDIS_ACTIVE_USERS_ZSET, members);

        const result: Array<{ userId: string; activityCount: number; isHot: boolean }> = members.map(
          (userId, i) => ({
            userId,
            activityCount: parseInt(counts[i] || '0', 10),
            isHot: (timestamps[i] ?? 0) >= hotCutoff,
          })
        );

        // Sort by activity count descending
        result.sort((a, b) => b.activityCount - a.activityCount);
        return result;
      }
    } catch (error) {
      logger.debug('Redis unavailable for getActiveUsers, using in-memory fallback');
    }

    // Fallback: in-memory Map
    const active: Array<{ userId: string; activityCount: number; isHot: boolean }> = [];
    for (const [userId, user] of this.fallbackActiveUsers.entries()) {
      const ts = user.lastActivity.getTime();
      if (now - ts < this.ACTIVE_USER_TTL_MS) {
        active.push({
          userId,
          activityCount: user.activityCount,
          isHot: now - ts < HOT_USER_THRESHOLD_MS,
        });
      }
    }
    active.sort((a, b) => b.activityCount - a.activityCount);
    return active;
  }

  /**
   * Clean up old active user records (older than TTL)
   */
  private async cleanupActiveUsers(): Promise<void> {
    const now = Date.now();
    const cutoff = now - this.ACTIVE_USER_TTL_MS;

    try {
      const client = getRedisClient();
      if (client.isReady) {
        // Get the members being removed so we can delete their counts too
        const expiredMembers = await client.zRangeByScore(
          REDIS_ACTIVE_USERS_ZSET,
          '-inf',
          cutoff
        );

        if (expiredMembers.length > 0) {
          await client.zRemRangeByScore(REDIS_ACTIVE_USERS_ZSET, '-inf', cutoff);
          await client.hDel(REDIS_ACTIVE_USERS_COUNTS, expiredMembers);
          logger.debug(`Cleaned up ${expiredMembers.length} inactive user records from Redis`);
        }
        return;
      }
    } catch (error) {
      logger.debug('Redis unavailable for cleanupActiveUsers, using in-memory fallback');
    }

    // Fallback: in-memory Map
    let cleaned = 0;
    for (const [userId, user] of this.fallbackActiveUsers.entries()) {
      if (now - user.lastActivity.getTime() >= this.ACTIVE_USER_TTL_MS) {
        this.fallbackActiveUsers.delete(userId);
        cleaned++;
      }
    }
    if (cleaned > 0) {
      logger.debug(`Cleaned up ${cleaned} inactive user records from in-memory fallback`);
    }
  }

  /**
   * Precompute feeds for active users using a tiered strategy:
   * - Hot users (active in last 1 hour): precompute all feeds (for_you, following, explore)
   * - Warm users (active in last 24 hours): precompute for_you only
   * No hard cap — configurable via MAX_PRECOMPUTE_USERS env var (default 500).
   */
  private async precomputeActiveUserFeeds(): Promise<void> {
    try {
      const activeUsers = await this.getActiveUsers();

      if (activeUsers.length === 0) {
        logger.debug('No active users to precompute feeds for');
        return;
      }

      // Apply configurable cap across all tiers combined
      const cappedUsers = activeUsers.slice(0, MAX_PRECOMPUTE_USERS);
      const hotUsers = cappedUsers.filter(u => u.isHot);
      const warmUsers = cappedUsers.filter(u => !u.isHot);

      logger.info(
        `Precomputing feeds: ${hotUsers.length} hot users (all feeds), ` +
        `${warmUsers.length} warm users (for_you only), ` +
        `${activeUsers.length} total active`
      );

      // Use Bull queue if available, otherwise process sequentially
      if (this.feedQueue) {
        const jobs = [];

        // Hot users: all three feed types
        for (const { userId } of hotUsers) {
          for (const feedType of ['for_you', 'following', 'explore'] as const) {
            jobs.push(
              this.feedQueue.add('precompute-feed', { userId, feedType, limit: 50 }, {
                priority: this.getUserPriority(userId)
              })
            );
          }
        }

        // Warm users: for_you only
        for (const { userId } of warmUsers) {
          jobs.push(
            this.feedQueue.add('precompute-feed', { userId, feedType: 'for_you', limit: 50 }, {
              priority: this.getUserPriority(userId)
            })
          );
        }

        await Promise.allSettled(jobs);
        logger.info(`Queued ${jobs.length} feed precomputation jobs`);
      } else {
        // Fallback: process sequentially (slower but works without Bull)
        for (const { userId } of hotUsers) {
          try {
            await Promise.all([
              feedCacheService.precomputeFeed(userId, 'for_you', 50),
              feedCacheService.precomputeFeed(userId, 'following', 50),
              feedCacheService.precomputeFeed(userId, 'explore', 50)
            ]);
          } catch (error) {
            logger.warn(`Failed to precompute feeds for hot user ${userId}:`, error);
          }
        }
        for (const { userId } of warmUsers) {
          try {
            await feedCacheService.precomputeFeed(userId, 'for_you', 50);
          } catch (error) {
            logger.warn(`Failed to precompute for_you feed for warm user ${userId}:`, error);
          }
        }
        logger.info(`Precomputed feeds for ${hotUsers.length} hot and ${warmUsers.length} warm users`);
      }
    } catch (error) {
      logger.error('Error precomputing feeds:', error);
    }
  }

  /**
   * Get priority for user (higher activity = higher priority).
   * Sync wrapper — reads from fallback map; Redis-backed callers use async path separately.
   */
  private getUserPriority(userId: string): number {
    // Use fallback map for sync priority lookup (Bull queue path)
    // This is a best-effort hint — not critical to be perfectly accurate
    const user = this.fallbackActiveUsers.get(userId);
    if (user) {
      return Math.min(100, user.activityCount);
    }
    return 1; // Default low priority for Redis-tracked users
  }

  /**
   * Update user preferences from recent activity
   */
  private async updateUserPreferences(): Promise<void> {
    try {
      logger.debug('Updating user preferences from recent activity...');

      const activeUsers = await this.getActiveUsers();

      // Batch update preferences for active users
      const updatePromises = activeUsers.slice(0, 50).map(({ userId }) =>
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
      // Record activity (fire-and-forget)
      void this.recordUserActivity(userId);

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
  async getActiveUserStats(): Promise<{ total: number; topUsers: Array<{ userId: string; activityCount: number }> }> {
    const activeUsers = await this.getActiveUsers();
    const topUsers = activeUsers.slice(0, 10).map(({ userId, activityCount }) => ({ userId, activityCount }));
    return {
      total: activeUsers.length,
      topUsers
    };
  }
}

export const feedJobScheduler = new FeedJobScheduler();
