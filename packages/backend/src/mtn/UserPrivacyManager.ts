/**
 * UserPrivacyManager
 *
 * Single source of truth for viewer-level author exclusions.
 *
 * Oxy owns blocks/restrictions. Mention owns only mutes, so request paths must
 * pass their authenticated, request-scoped Oxy client instead of consulting
 * stale duplicate Block/Restrict collections.
 */

import { eq } from 'drizzle-orm';
import { getDb } from '../db/postgres';
import { mutes } from '../db/schema/engagement';
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
  /**
   * Whether restricted users join `excludedUserIds`. Recommendations exclude
   * them; feeds only block + mute.
   *
   * It governs the EXCLUSION only. `restrictedUserIds` is resolved either way —
   * it used to be silently empty unless this flag was set, so a caller reading
   * that field got "this viewer restricts nobody" and no way to tell that apart
   * from the truth. The feed reads it (to thread into hydration) without
   * excluding on it, which the old coupling made unstateable.
   */
  includeRestricted?: boolean;
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

export class UserPrivacyManager {
  /**
   * Load privacy relations concurrently from their authoritative stores.
   *
   * A mute read failure must not discard successfully resolved Oxy
   * blocks. Oxy privacy failures propagate because returning a partial set can
   * disclose an excluded author.
   */
  static async loadPrivacyState(
    userId: string,
    options: LoadPrivacyStateOptions = {},
  ): Promise<PrivacyState> {
    // Postgres. This read the Mongo `Mute` collection until now, which nothing
    // has written since mutes moved — so a mute created after the cutover was
    // never applied, and the reader kept seeing an author they had explicitly
    // silenced. The fail-soft below makes that especially worth naming: an empty
    // result is indistinguishable from "no mutes", so the failure mode was a
    // silently permissive privacy state rather than an error.
    const mutedUsersPromise = getDb()
      .select({ mutedId: mutes.mutedId })
      .from(mutes)
      .where(eq(mutes.userId, userId))
      .catch((error): Array<{ mutedId: string }> => {
        logger.warn('[UserPrivacyManager] Failed to load Mention mutes', error);
        return [];
      });

    const [blockedIds, mutedUsers, restrictedIds] = await Promise.all([
      getBlockedUserIds(options.oxyClient),
      mutedUsersPromise,
      getRestrictedUserIds(options.oxyClient),
    ]);

    const blockedUserIds = new Set(blockedIds.filter(validId));
    const mutedUserIds = new Set(
      mutedUsers.map((mute) => mute.mutedId).filter(validId),
    );
    const restrictedUserIds = new Set(restrictedIds.filter(validId));
    const excludedUserIds = new Set<string>([
      ...blockedUserIds,
      ...mutedUserIds,
      ...(options.includeRestricted ? restrictedUserIds : []),
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
