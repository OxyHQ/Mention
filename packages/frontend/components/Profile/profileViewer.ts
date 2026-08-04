import type { ProfileData } from '@/hooks/useProfileData';

/**
 * The two questions every profile surface asks about the VIEWER, answered once.
 *
 * They were derived inline in the profile screen while that screen was the only
 * reader. On web it is no longer: the chrome lives in the tab group's LAYOUT and
 * the tab content in a routed SCREEN, and both have to reach the same verdict —
 * a disagreement shows a private profile's posts under a "this profile is
 * private" chrome, or the reverse.
 */

/**
 * Whether the account withholds its posts from non-followers.
 *
 * `followers_only` counts: the profile-visibility gate the feed applies is the
 * same for both values (`canViewAuthorFeed` serves an empty author feed to a
 * non-follower either way), so a surface that treated them differently would
 * promise content the server will not send.
 */
export function isProfilePrivate(profileData: ProfileData | null): boolean {
  if (!profileData) return false;
  const visibility = profileData.privacy?.profileVisibility;
  return visibility === 'private' || visibility === 'followers_only';
}

/**
 * Whether this profile is the viewer's own.
 *
 * A FEDERATED profile never is, whatever the ids say: a remote actor is mirrored
 * into Oxy under an id of its own, and the viewer's session can never be that
 * actor. Checked first so an id collision cannot hand somebody the owner's view
 * of a remote account.
 */
export function viewerOwnsProfile(
  profileData: ProfileData | null,
  currentUserId: string | undefined,
  isFederated: boolean,
): boolean {
  if (isFederated) return false;
  if (!currentUserId || !profileData?.id) return false;
  return currentUserId === profileData.id;
}
