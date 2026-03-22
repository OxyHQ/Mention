/**
 * UserPrivacyManager
 *
 * Single source of truth for blocked users, muted users, and hidden posts.
 * Replaces scattered privacy logic across feed controller, hydration service, and preference service.
 */

import Block from '../models/Block';
import Mute from '../models/Mute';
import { logger } from '../utils/logger';

export interface PrivacyState {
  blockedUserIds: Set<string>;
  mutedUserIds: Set<string>;
  /** Combined blocked + muted for quick filtering */
  excludedUserIds: Set<string>;
}

export class UserPrivacyManager {
  /**
   * Load the privacy state for a user in a single batch.
   */
  static async loadPrivacyState(userId: string): Promise<PrivacyState> {
    try {
      const [blocks, mutes] = await Promise.all([
        Block.find({ userId }).select('blockedId').lean(),
        Mute.find({ userId }).select('mutedId').lean(),
      ]);

      const blockedUserIds = new Set<string>(blocks.map((b) => b.blockedId));
      const mutedUserIds = new Set<string>(mutes.map((m) => m.mutedId));
      const excludedUserIds = new Set<string>([...blockedUserIds, ...mutedUserIds]);

      return { blockedUserIds, mutedUserIds, excludedUserIds };
    } catch (error) {
      logger.error('[UserPrivacyManager] Failed to load privacy state', error);
      return {
        blockedUserIds: new Set(),
        mutedUserIds: new Set(),
        excludedUserIds: new Set(),
      };
    }
  }

  /**
   * Filter out posts from blocked/muted users.
   */
  static filterPosts<T extends { oxyUserId?: string }>(
    posts: T[],
    privacyState: PrivacyState
  ): T[] {
    if (privacyState.excludedUserIds.size === 0) return posts;
    return posts.filter((post) => {
      if (!post.oxyUserId) return true;
      return !privacyState.excludedUserIds.has(post.oxyUserId);
    });
  }

  /**
   * Check if a specific user is blocked or muted.
   */
  static isExcluded(userId: string, privacyState: PrivacyState): boolean {
    return privacyState.excludedUserIds.has(userId);
  }
}
