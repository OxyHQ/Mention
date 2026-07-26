/**
 * UserPrivacyManager
 *
 * Single source of truth for viewer-level author exclusions.
 *
 * Oxy owns blocks/restrictions. Mention owns only mutes, so request paths must
 * pass their authenticated, request-scoped Oxy client instead of consulting
 * stale duplicate Block/Restrict collections.
 */

import Mute from '../models/Mute';
import {
  getBlockedUserIds,
  getRestrictedUserIds,
  type OxyClient,
} from '../utils/privacyHelpers';
import { logger } from '../utils/logger';

export interface PrivacyState {
  blockedUserIds: Set<string>;
  mutedUserIds: Set<string>;
  restrictedUserIds: Set<string>;
  /** Combined blocked + muted (+ restricted when requested) for quick filtering. */
  excludedUserIds: Set<string>;
}

export interface LoadPrivacyStateOptions {
  /**
   * Authenticated per-request Oxy client. It is required for viewer-owned
   * privacy reads; a missing context fails closed rather than guessing that the
   * account has no blocks or restrictions.
   */
  oxyClient?: OxyClient;
  /** Recommendations exclude restricted users; feeds only need block + mute. */
  includeRestricted?: boolean;
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

export class UserPrivacyManager {
  /**
   * Load privacy relations concurrently from their authoritative stores.
   *
   * A Mongo mute read failure must not discard successfully resolved Oxy
   * blocks. Oxy privacy failures propagate because returning a partial set can
   * disclose an excluded author.
   */
  static async loadPrivacyState(
    userId: string,
    options: LoadPrivacyStateOptions = {},
  ): Promise<PrivacyState> {
    const mutedUsersPromise = Mute.find(
      { userId },
      { mutedId: 1, _id: 0 },
    )
      .lean()
      .catch((error): Array<{ mutedId?: string }> => {
        logger.warn('[UserPrivacyManager] Failed to load Mention mutes', error);
        return [];
      });

    const [blockedIds, mutedUsers, restrictedIds] = await Promise.all([
      getBlockedUserIds(options.oxyClient),
      mutedUsersPromise,
      options.includeRestricted
        ? getRestrictedUserIds(options.oxyClient)
        : Promise.resolve<string[]>([]),
    ]);

    const blockedUserIds = new Set(blockedIds.filter(validId));
    const mutedUserIds = new Set(
      mutedUsers.map((mute) => mute.mutedId).filter(validId),
    );
    const restrictedUserIds = new Set(restrictedIds.filter(validId));
    const excludedUserIds = new Set<string>([
      ...blockedUserIds,
      ...mutedUserIds,
      ...restrictedUserIds,
    ]);

    return {
      blockedUserIds,
      mutedUserIds,
      restrictedUserIds,
      excludedUserIds,
    };
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
