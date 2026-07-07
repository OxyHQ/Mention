import { useEffect, useRef } from 'react';
import { useFollow } from '@oxyhq/services';
import { feedService } from '@/services/feedService';
import { createScopedLogger } from '@/lib/logger';

const logger = createScopedLogger('FederatedFollowSync');

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
      feedService.followFederatedActor(actorUri).catch((error) => {
        // The Oxy follow edge already flipped optimistically; the ActivityPub
        // bridge failing must not be silent — a dropped Follow means the remote
        // server never learns about the follow (no posts, no accept).
        logger.warn('Failed to bridge follow to ActivityPub', { actorUri, error });
      });
    } else {
      feedService.unfollowFederatedActor(actorUri).catch((error) => {
        logger.warn('Failed to bridge unfollow to ActivityPub', { actorUri, error });
      });
    }
  }, [isFederated, actorUri, profileId, isFollowing]);
}
