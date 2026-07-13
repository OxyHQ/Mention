import React, { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { show as toast } from '@oxyhq/bloom/toast';
import { FollowButton, useAuth } from '@oxyhq/services';

import { Button } from '@/components/ui/Button';
import { feedService, type ExternalActorResolution } from '@/services/feedService';
import { createScopedLogger } from '@/lib/logger';

const logger = createScopedLogger('ExternalActorFollow');

interface ExternalActorFollowButtonProps {
  /** The cross-network actor resolved by `GET /federation/resolve`. */
  actor: ExternalActorResolution;
}

/**
 * The follow control of a cross-network (Mastodon / Bluesky) actor's row, which
 * renders inline among the normal people results.
 *
 * A resolved actor is in one of two identity states, and each needs a different
 * follow path:
 *
 *  - **Already minted in Oxy** (`oxyUserId`) — the row follows through the app's
 *    canonical {@link FollowButton}, so it shares the follow store with every
 *    other surface (an account followed elsewhere already reads "Following") and
 *    writes the Oxy graph edge the feeds are built on. The external network is
 *    bridged from the event handler — `POST /federation/follow` / `/unfollow`,
 *    the same bridge `useFederatedFollowSync` performs on the profile screen.
 *  - **Not an Oxy user yet** — a handle nobody here has ever resolved has no Oxy
 *    id to follow, so the follow goes straight to `POST /federation/follow`,
 *    keyed on the actor's canonical protocol id (an ActivityPub actor URI or an
 *    atproto DID). A locked remote account accepts it as a pending REQUEST, which
 *    the button reflects.
 */
export function ExternalActorFollowButton({ actor }: ExternalActorFollowButtonProps) {
  const { t } = useTranslation();
  const { canUsePrivateApi } = useAuth();

  const [following, setFollowing] = useState(actor.followed);
  const [submitting, setSubmitting] = useState(false);
  // The remote account is locked: the follow was accepted as a REQUEST awaiting
  // the actor's approval (`pending: true` from `POST /federation/follow`).
  const [requested, setRequested] = useState(false);

  /** Mirror an Oxy follow/unfollow onto the actor's own network. */
  const bridgeToNetwork = useCallback(
    (isFollowing: boolean) => {
      const bridged = isFollowing
        ? feedService.followFederatedActor(actor.externalId)
        : feedService.unfollowFederatedActor(actor.externalId);
      bridged.catch((error: unknown) => {
        // The Oxy edge already flipped optimistically; the bridge failing must not
        // be silent — a dropped Follow means the remote server never learns about
        // it (no posts, no accept).
        logger.warn('Failed to bridge follow to the external network', {
          actorUri: actor.externalId,
          error,
        });
      });
    },
    [actor.externalId],
  );

  const followExternalActor = useCallback(async () => {
    if (submitting || following) return;
    setSubmitting(true);
    try {
      const result = await feedService.followFederatedActor(actor.externalId);
      if (!result.success) {
        toast(t('search.external.followFailed', { defaultValue: 'Could not follow this account' }), {
          type: 'error',
        });
        return;
      }
      setFollowing(true);
      setRequested(result.pending);
    } catch (error) {
      logger.warn('Federated follow failed', { actorUri: actor.externalId, error });
      toast(t('search.external.followFailed', { defaultValue: 'Could not follow this account' }), {
        type: 'error',
      });
    } finally {
      setSubmitting(false);
    }
  }, [submitting, following, actor.externalId, t]);

  // Matches every other people row: no follow affordance for a viewer who cannot
  // call private APIs (`FollowButton` renders nothing in that state either).
  if (!canUsePrivateApi) return null;

  if (actor.oxyUserId) {
    return <FollowButton userId={actor.oxyUserId} size="small" onFollowChange={bridgeToNetwork} />;
  }

  return (
    <Button
      variant={following ? 'secondary' : 'primary'}
      size="small"
      onPress={() => void followExternalActor()}
      disabled={following || submitting}>
      {requested
        ? t('search.external.requested', { defaultValue: 'Requested' })
        : following
          ? t('search.external.following', { defaultValue: 'Following' })
          : submitting
            ? t('search.external.followingPending', { defaultValue: 'Following…' })
            : t('search.external.follow', { defaultValue: 'Follow' })}
    </Button>
  );
}
