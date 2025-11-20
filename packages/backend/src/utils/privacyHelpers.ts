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

