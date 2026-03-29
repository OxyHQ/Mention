import { useEffect, useRef } from 'react';
import { useFollow } from '@oxyhq/services';
import { feedService } from '@/services/feedService';

/**
 * Watches the Oxy follow state for a federated profile and bridges it
 * to the ActivityPub layer by calling the federation follow/unfollow
 * endpoints when the local follow state transitions.
 *
 * This hook is a no-op when `isFederated` is false or `actorUri` is absent.
 */
export function useFederatedFollowSync(
  profileId?: string,
  isFederated?: boolean,
  actorUri?: string
) {
  const oxyUserId = isFederated && profileId ? profileId : '';
  const { isFollowing } = useFollow(oxyUserId);

  const settledRef = useRef(false);
  const prevFollowingRef = useRef(isFollowing);
  const prevProfileIdRef = useRef(profileId);

  // Reset tracking when the profile changes (component reused via dynamic route)
  if (prevProfileIdRef.current !== profileId) {
    prevProfileIdRef.current = profileId;
    settledRef.current = false;
    prevFollowingRef.current = isFollowing;
  }

  useEffect(() => {
    if (!isFederated || !actorUri || !profileId) return;

    // Skip the first value — it's the initial hydration from the store,
    // not a user-initiated transition.
    if (!settledRef.current) {
      settledRef.current = true;
      prevFollowingRef.current = isFollowing;
      return;
    }

    const wasFollowing = prevFollowingRef.current;
    prevFollowingRef.current = isFollowing;

    if (wasFollowing === isFollowing) return;

    if (isFollowing) {
      feedService.followFederatedActor(actorUri).catch(() => {});
    } else {
      feedService.unfollowFederatedActor(actorUri).catch(() => {});
    }
  }, [isFederated, actorUri, profileId, isFollowing]);
}
