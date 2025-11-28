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
 * Extract user ID from blocked/restricted user entry
 * Handles different response formats from Oxy API
 */
export function extractUserIdFromBlockedRestricted(entry: any): string | undefined {
  if (!entry) return undefined;
  
  if (entry?.blockedId) {
    return typeof entry.blockedId === 'string' ? entry.blockedId : entry.blockedId._id;
  }
  if (entry?.restrictedId) {
    return typeof entry.restrictedId === 'string' ? entry.restrictedId : entry.restrictedId._id;
  }
  return entry?.id || entry?._id || entry?.userId || entry?.targetId;
}

/**
 * Check if an error is a network error (transient, can be retried)
 */
function isNetworkError(error: any): boolean {
  if (!error) return false;
  // Check for network error indicators
  return (
    error.code === 'NETWORK_ERROR' ||
    error.status === 0 ||
    (error.message && typeof error.message === 'string' && error.message.toLowerCase().includes('network'))
  );
}

/**
 * Get user IDs from Oxy privacy API (blocked or restricted users)
 * @param getUserList - Function to fetch the user list from Oxy API
 * @param listType - Type of list for error logging ('blocked' or 'restricted')
 * @returns Array of user IDs
 */
async function getUserIdsFromPrivacyList(
  getUserList: () => Promise<any[]>,
  listType: 'blocked' | 'restricted'
): Promise<string[]> {
  try {
    const users = await getUserList();
    return users
      .map(extractUserIdFromBlockedRestricted)
      .filter((id): id is string => Boolean(id));
  } catch (error) {
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
 * Note: Oxy service uses authenticated context, so no userId parameter needed
 */
export async function getBlockedUserIds(): Promise<string[]> {
  return getUserIdsFromPrivacyList(() => oxy.getBlockedUsers(), 'blocked');
}

/**
 * Get restricted user IDs for the authenticated user from Oxy
 * Note: Oxy service uses authenticated context, so no userId parameter needed
 */
export async function getRestrictedUserIds(): Promise<string[]> {
  return getUserIdsFromPrivacyList(() => oxy.getRestrictedUsers(), 'restricted');
}

/**
 * Extract user IDs from Oxy following response
 * Handles various response formats from Oxy API
 */
export function extractFollowingIds(followingRes: any): string[] {
  const followingList = Array.isArray((followingRes as any)?.following)
    ? (followingRes as any).following
    : (Array.isArray(followingRes) ? followingRes : []);
  
  return followingList
    .map((u: any) => 
      typeof u === 'string' 
        ? u 
        : (u?.id || u?._id || u?.userId || u?.user?.id || u?.profile?.id || u?.targetId)
    )
    .filter(Boolean);
}

/**
 * Extract user IDs from Oxy followers response
 * Handles various response formats from Oxy API
 */
export function extractFollowersIds(followersRes: any): string[] {
  const followersList = Array.isArray((followersRes as any)?.followers)
    ? (followersRes as any).followers
    : (Array.isArray(followersRes) ? followersRes : []);
  
  return followersList
    .map((entry: any) => {
      if (typeof entry === 'string') {
        return entry;
      }
      return entry?.id || entry?._id || entry?.userId || entry?.oxyUserId || entry?.user?.id || entry?.profile?.id || entry?.targetId;
    })
    .filter(Boolean);
}

/**
 * Check if a user is following another user
 * @param viewerId - The user checking access
 * @param targetUserId - The user being checked
 * @returns true if viewer follows target, false otherwise
 */
export async function checkFollowAccess(viewerId: string, targetUserId: string): Promise<boolean> {
  try {
    const followingRes = await oxy.getUserFollowing(viewerId);
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

