import { userPreferenceService } from './UserPreferenceService';
import { scheduledPostPublisher } from './ScheduledPostPublisher';
import { logger } from '../utils/logger';
import { getRedisClient } from '../utils/redis';

/**
 * FeedJobScheduler - Background jobs for feed maintenance
 * Similar to how Twitter/Facebook refresh feeds in the background
 *
 * Jobs:
 * - Update user preferences from recent activity
 * - Track active users and clean stale records
 */

interface ActiveUser {
  userId: string;
  lastActivity: Date;
  activityCount: number;
}

// Redis key constants
const REDIS_ACTIVE_USERS_ZSET = 'feed:active_users';
const REDIS_ACTIVE_USERS_COUNTS = 'feed:active_users:counts';

export class FeedJobScheduler {
  private intervals: Map<string, NodeJS.Timeout> = new Map();
  private isRunning: boolean = false;

  // Fallback in-memory Map used when Redis is unavailable
  private fallbackActiveUsers: Map<string, ActiveUser> = new Map();
  private readonly ACTIVE_USER_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

  /**
   * Start background jobs
   */
  start(): void {
    if (this.isRunning) {
      return;
    }

    this.isRunning = true;

    // Update user preferences every hour
    const updatePreferencesTimer = setInterval(() => {
      this.updateUserPreferences().catch(err => {
        logger.error('Error in update preferences job:', err);
      });
    }, 60 * 60 * 1000) as unknown as NodeJS.Timeout; // 1 hour
    updatePreferencesTimer.unref?.();
    this.intervals.set('updatePreferences', updatePreferencesTimer);

    // Clean up old active user records every hour
    const cleanActiveUsersTimer = setInterval(() => {
      this.cleanupActiveUsers().catch(err => {
        logger.error('Error in cleanup active users job:', err);
      });
    }, 60 * 60 * 1000) as unknown as NodeJS.Timeout; // 1 hour
    cleanActiveUsersTimer.unref?.();
    this.intervals.set('cleanActiveUsers', cleanActiveUsersTimer);

    // Publish due scheduled posts every 60s. This scheduler only runs on the
    // elected leader (see server.ts startSchedulers), so the sweep runs on
    // exactly one task; the publisher additionally guards against overlap.
    const publishScheduledTimer = setInterval(() => {
      scheduledPostPublisher.publishDuePosts().catch(err => {
        logger.error('Error in scheduled post publish job:', err);
      });
    }, 60 * 1000) as unknown as NodeJS.Timeout; // 60 seconds
    publishScheduledTimer.unref?.();
    this.intervals.set('publishScheduledPosts', publishScheduledTimer);

    logger.info('Feed job scheduler started');
  }

  /**
   * Stop background jobs
   */
  stop(): void {
    this.intervals.forEach(interval => clearInterval(interval));
    this.intervals.clear();
    this.isRunning = false;

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
   */
  private async getActiveUsers(): Promise<Array<{ userId: string; activityCount: number }>> {
    const now = Date.now();
    const cutoff = now - this.ACTIVE_USER_TTL_MS;

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

        const result: Array<{ userId: string; activityCount: number }> = members.map(
          (userId, i) => ({
            userId,
            activityCount: parseInt(counts[i] || '0', 10),
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
    const active: Array<{ userId: string; activityCount: number }> = [];
    for (const [userId, user] of this.fallbackActiveUsers.entries()) {
      const ts = user.lastActivity.getTime();
      if (now - ts < this.ACTIVE_USER_TTL_MS) {
        active.push({
          userId,
          activityCount: user.activityCount,
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
