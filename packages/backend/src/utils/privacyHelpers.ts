import { oxy } from '../../server';
import { logger } from './logger';

/**
 * Privacy visibility constants
 */
export const ProfileVisibility = {
  PUBLIC: 'public',
  PRIVATE: 'private',
  FOLLOWERS_ONLY: 'followers_only',
} as const;

export type ProfileVisibilityType = typeof ProfileVisibility[keyof typeof ProfileVisibility];

/**
 * Minimal interface for the OxyServices methods we need. Return types are
 * deliberately `unknown` because the Oxy privacy/follow endpoints have several
 * historical response shapes; the `extract*`/`readIdRef` helpers below narrow
 * them defensively at the boundary.
 */
export interface OxyClient {
  getBlockedUsers(): Promise<unknown[]>;
  getRestrictedUsers(): Promise<unknown[]>;
  getUserFollowing(userId: string): Promise<unknown>;
  getUserFollowers(userId: string): Promise<unknown>;
}

/** Read a string-or-`{_id}` reference, returning the resolved id string when present. */
function readIdRef(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  const nested = readProp(value, '_id');
  return typeof nested === 'string' ? nested : undefined;
}

/** Read a property off an unknown object-like value, else undefined. */
function readProp(value: unknown, key: string): unknown {
  return value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined;
}

/** First string-valued property among the candidates, else undefined. */
function firstStringProp(value: unknown, keys: string[]): string | undefined {
  for (const key of keys) {
    const candidate = readProp(value, key);
    if (typeof candidate === 'string' && candidate.length > 0) return candidate;
  }
  return undefined;
}

/**
 * Extract user ID from blocked/restricted user entry
 * Handles different response formats from Oxy API
 */
export function extractUserIdFromBlockedRestricted(entry: unknown): string | undefined {
  if (!entry) return undefined;

  const blockedId = readProp(entry, 'blockedId');
  if (blockedId) {
    return readIdRef(blockedId);
  }
  const restrictedId = readProp(entry, 'restrictedId');
  if (restrictedId) {
    return readIdRef(restrictedId);
  }
  return firstStringProp(entry, ['id', '_id', 'userId', 'targetId']);
}

/**
 * Check if an error is a network error (transient, can be retried)
 */
function isNetworkError(error: unknown): boolean {
  if (!error) return false;
  // Check for network error indicators
  const message = readProp(error, 'message');
  return (
    readProp(error, 'code') === 'NETWORK_ERROR' ||
    readProp(error, 'status') === 0 ||
    (typeof message === 'string' && message.toLowerCase().includes('network'))
  );
}

function getErrorStatus(error: unknown): number | undefined {
  const status =
    readProp(error, 'status') ??
    readProp(error, 'statusCode') ??
    readProp(readProp(error, 'response'), 'status');
  return typeof status === 'number' ? status : undefined;
}

function isAuthContextError(error: unknown): boolean {
  if (!error) return false;
  const status = getErrorStatus(error);
  if (status === 401 || status === 403) return true;

  const rawCode = readProp(error, 'code');
  const code = typeof rawCode === 'string' ? rawCode.toUpperCase() : '';
  if (code === 'UNAUTHORIZED' || code === 'FORBIDDEN') return true;

  const rawMessage = readProp(error, 'message');
  const message = typeof rawMessage === 'string' ? rawMessage.toLowerCase() : '';
  return message.includes('authorization header') || message.includes('unauthorized');
}

/**
 * Get user IDs from Oxy privacy API (blocked or restricted users)
 * @param getUserList - Function to fetch the user list from Oxy API
 * @param listType - Type of list for error logging ('blocked' or 'restricted')
 * @returns Array of user IDs
 */
async function getUserIdsFromPrivacyList(
  getUserList: () => Promise<unknown[]>,
  listType: 'blocked' | 'restricted'
): Promise<string[]> {
  try {
    const users = await getUserList();
    return users
      .map(extractUserIdFromBlockedRestricted)
      .filter((id): id is string => Boolean(id));
  } catch (error) {
    if (isAuthContextError(error)) {
      logger.debug(`[PostHydration] Skipping ${listType} users: authenticated Oxy privacy context unavailable`, {
        status: getErrorStatus(error),
        code: typeof (error as { code?: unknown })?.code === 'string' ? (error as { code: string }).code : undefined,
      });
      return [];
    }

    // Network errors are transient and handled gracefully (returning empty array)
    // Log them at WARN level to reduce noise, other errors at ERROR level
    if (isNetworkError(error)) {
      logger.warn(`Network error getting ${listType} users (handled gracefully):`, error);
    } else {
      logger.error(`Error getting ${listType} users:`, error);
    }
    return []; // On error, return empty array
  }
}

/**
 * Get blocked user IDs for the authenticated user from Oxy
 * @param client - OxyServices instance (per-request, with auth token set)
 */
export async function getBlockedUserIds(client?: OxyClient): Promise<string[]> {
  if (!client) return [];
  return getUserIdsFromPrivacyList(() => client.getBlockedUsers(), 'blocked');
}

/**
 * Get restricted user IDs for the authenticated user from Oxy
 * @param client - OxyServices instance (per-request, with auth token set)
 */
export async function getRestrictedUserIds(client?: OxyClient): Promise<string[]> {
  if (!client) return [];
  return getUserIdsFromPrivacyList(() => client.getRestrictedUsers(), 'restricted');
}

/**
 * Extract user IDs from Oxy following response
 * Handles various response formats from Oxy API
 */
export function extractFollowingIds(followingRes: unknown): string[] {
  const following = readProp(followingRes, 'following');
  const followingList: unknown[] = Array.isArray(following)
    ? following
    : (Array.isArray(followingRes) ? followingRes : []);

  return followingList
    .map((u): string | undefined =>
      typeof u === 'string'
        ? u
        : (firstStringProp(u, ['id', '_id', 'userId'])
          ?? firstStringProp(readProp(u, 'user'), ['id'])
          ?? firstStringProp(readProp(u, 'profile'), ['id'])
          ?? firstStringProp(u, ['targetId']))
    )
    .filter((id): id is string => Boolean(id));
}

/**
 * Extract user IDs from Oxy followers response
 * Handles various response formats from Oxy API
 */
export function extractFollowersIds(followersRes: unknown): string[] {
  const followers = readProp(followersRes, 'followers');
  const followersList: unknown[] = Array.isArray(followers)
    ? followers
    : (Array.isArray(followersRes) ? followersRes : []);

  return followersList
    .map((entry): string | undefined => {
      if (typeof entry === 'string') {
        return entry;
      }
      return firstStringProp(entry, ['id', '_id', 'userId', 'oxyUserId'])
        ?? firstStringProp(readProp(entry, 'user'), ['id'])
        ?? firstStringProp(readProp(entry, 'profile'), ['id'])
        ?? firstStringProp(entry, ['targetId']);
    })
    .filter((id): id is string => Boolean(id));
}

/**
 * Check if a user is following another user
 * @param viewerId - The user checking access
 * @param targetUserId - The user being checked
 * @param client - Optional per-request OxyServices instance
 * @returns true if viewer follows target, false otherwise
 */
export async function checkFollowAccess(viewerId: string, targetUserId: string, client?: OxyClient): Promise<boolean> {
  try {
    const c = client || oxy;
    const followingRes = await c.getUserFollowing(viewerId);
    const followingIds = extractFollowingIds(followingRes);
    return followingIds.includes(targetUserId);
  } catch (error) {
    logger.error('Error checking follow access:', error);
    return false; // On error, deny access for privacy
  }
}

/**
 * Check if a profile requires access check (private or followers_only)
 */
export function requiresAccessCheck(profileVisibility: string | undefined): boolean {
  return profileVisibility === ProfileVisibility.PRIVATE ||
         profileVisibility === ProfileVisibility.FOLLOWERS_ONLY;
}
