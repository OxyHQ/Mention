import { oxy } from '../../server';

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
 * Extract user IDs from Oxy blocked users response
 */
export function extractBlockedUserIds(blockedRes: any): string[] {
  if (!blockedRes) return [];
  
  // Handle different response formats
  if (Array.isArray(blockedRes)) {
    return blockedRes
      .map((u: any) => typeof u === 'string' ? u : (u?.id || u?._id || u?.userId || u?.blockedId))
      .filter(Boolean);
  }
  
  if (blockedRes?.blockedUsers && Array.isArray(blockedRes.blockedUsers)) {
    return blockedRes.blockedUsers
      .map((u: any) => typeof u === 'string' ? u : (u?.id || u?._id || u?.userId || u?.blockedId))
      .filter(Boolean);
  }
  
  if (blockedRes?.blocked && Array.isArray(blockedRes.blocked)) {
    return blockedRes.blocked
      .map((u: any) => typeof u === 'string' ? u : (u?.id || u?._id || u?.userId || u?.blockedId))
      .filter(Boolean);
  }
  
  return [];
}

/**
 * Extract user IDs from Oxy restricted users response
 */
export function extractRestrictedUserIds(restrictedRes: any): string[] {
  if (!restrictedRes) return [];
  
  // Handle different response formats
  if (Array.isArray(restrictedRes)) {
    return restrictedRes
      .map((u: any) => typeof u === 'string' ? u : (u?.id || u?._id || u?.userId || u?.restrictedId))
      .filter(Boolean);
  }
  
  if (restrictedRes?.restrictedUsers && Array.isArray(restrictedRes.restrictedUsers)) {
    return restrictedRes.restrictedUsers
      .map((u: any) => typeof u === 'string' ? u : (u?.id || u?._id || u?.userId || u?.restrictedId))
      .filter(Boolean);
  }
  
  if (restrictedRes?.restricted && Array.isArray(restrictedRes.restricted)) {
    return restrictedRes.restricted
      .map((u: any) => typeof u === 'string' ? u : (u?.id || u?._id || u?.userId || u?.restrictedId))
      .filter(Boolean);
  }
  
  return [];
}

/**
 * Get blocked user IDs for the authenticated user from Oxy
 * Note: Oxy service uses authenticated context, so no userId parameter needed
 */
export async function getBlockedUserIds(): Promise<string[]> {
  try {
    const blockedUsers = await oxy.getBlockedUsers();
    return blockedUsers
      .map(extractUserIdFromBlockedRestricted)
      .filter((id): id is string => Boolean(id));
  } catch (error) {
    console.error('Error getting blocked users:', error);
    return []; // On error, return empty array
  }
}

/**
 * Get restricted user IDs for the authenticated user from Oxy
 * Note: Oxy service uses authenticated context, so no userId parameter needed
 */
export async function getRestrictedUserIds(): Promise<string[]> {
  try {
    const restrictedUsers = await oxy.getRestrictedUsers();
    return restrictedUsers
      .map(extractUserIdFromBlockedRestricted)
      .filter((id): id is string => Boolean(id));
  } catch (error) {
    console.error('Error getting restricted users:', error);
    return []; // On error, return empty array
  }
}

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
    console.error('Error checking follow access:', error);
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

