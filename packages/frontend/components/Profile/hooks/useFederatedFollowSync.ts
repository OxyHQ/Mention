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
  profileId: string | undefined,
  isFederated: boolean | undefined,
  actorUri: string | undefined,
) {
  const oxyUserId = isFederated && profileId ? profileId : '';
  const { isFollowing } = useFollow(oxyUserId);

  const settledRef = useRef(false);
  const prevFollowingRef = useRef(isFollowing);
  const prevIdentityRef = useRef(oxyUserId);

  // Reset tracking when the profile identity changes (mirrors ProfileScreen pattern)
  if (prevIdentityRef.current !== oxyUserId) {
    prevIdentityRef.current = oxyUserId;
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
    }

    const wasFollowing = prevFollowingRef.current;
    prevFollowingRef.current = isFollowing;

    if (wasFollowing === isFollowing) return;

    if (isFollowing) {
      feedService.followFederatedActor(actorUri).catch(err => {
        console.warn('[Federation] Failed to send AP Follow:', err);
      });
    } else {
      feedService.unfollowFederatedActor(actorUri).catch(err => {
        console.warn('[Federation] Failed to send AP Unfollow:', err);
      });
    }
  }, [isFederated, actorUri, profileId, isFollowing]);
}
