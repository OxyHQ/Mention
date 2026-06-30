import React, { useCallback, useMemo, useState } from 'react';
import { View, TouchableOpacity, StyleSheet, type GestureResponderEvent } from 'react-native';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { show as toast } from '@oxyhq/bloom/toast';
import { Avatar } from '@oxyhq/bloom/avatar';
import { useTheme } from '@oxyhq/bloom/theme';
import { useAuth } from '@oxyhq/services';
import { getNormalizedUserHandle } from '@oxyhq/core';

import { ThemedText } from '@/components/ThemedText';
import { Button } from '@/components/ui/Button';
import { FediverseIcon } from '@/assets/icons/fediverse-icon';
import { displayNameOrHandle } from '@/utils/displayName';
import { proxyExternalUrl } from '@/utils/imageUrlCache';
import {
  feedService,
  type ExternalActorResolution,
  type ExternalNetwork,
} from '@/services/feedService';

interface ExternalActorCardProps {
  actor: ExternalActorResolution;
}

/** Human-readable label for a normalized network. */
const NETWORK_LABEL: Record<ExternalNetwork, string> = {
  activitypub: 'Mastodon',
  atproto: 'Bluesky',
};

/** Keep a press on the Follow button from also opening the profile (web nested pressables). */
function stopPropagation(event: GestureResponderEvent): void {
  event.stopPropagation();
}

/**
 * Cross-network external actor result card.
 *
 * Renders a remote actor resolved via `GET /federation/resolve` (Mastodon /
 * Bluesky) as a normalized card: avatar, display name, fediverse-style handle, a
 * network badge, and a Follow action. Following calls `POST /federation/follow`
 * (protocol-dispatched on the backend) and, on success, routes into the existing
 * federated-profile screen via the normalized Oxy handle.
 */
export function ExternalActorCard({ actor }: ExternalActorCardProps) {
  const router = useRouter();
  const theme = useTheme();
  const { t } = useTranslation();
  const { isAuthenticated, showBottomSheet } = useAuth();

  const [following, setFollowing] = useState(actor.followed);
  const [pending, setPending] = useState(false);

  const displayName = displayNameOrHandle(actor.displayName, `@${actor.handle}`);
  const networkLabel = NETWORK_LABEL[actor.network];

  // The avatar URL from a resolve is a REMOTE actor URL (Mastodon/Bluesky CDN) —
  // route it through the media proxy so it loads on web and stays cached. Passing
  // a full http URL to Bloom Avatar bypasses the file-id ImageResolver.
  const avatarSource = useMemo(
    () => (actor.avatarUrl ? proxyExternalUrl(actor.avatarUrl) : undefined),
    [actor.avatarUrl],
  );

  // The route handle for the federated profile screen (resolves by Oxy handle:
  // `user@domain` for ActivityPub via WebFinger, the bare handle for atproto).
  const profileHandle = useMemo(
    () =>
      getNormalizedUserHandle({
        username: actor.handle,
        instance: undefined,
        isFederated: true,
      }) || actor.handle,
    [actor.handle],
  );

  const openProfile = useCallback(() => {
    if (!profileHandle) return;
    router.push(`/@${profileHandle}`);
  }, [router, profileHandle]);

  const handleFollow = useCallback(async () => {
    if (pending) return;
    if (!isAuthenticated) {
      showBottomSheet?.('OxyAuth');
      return;
    }
    setPending(true);
    try {
      // Follow the actor's CANONICAL protocol id (AP actor URI / atproto DID).
      const result = await feedService.followFederatedActor(actor.externalId);
      if (result.success) {
        setFollowing(true);
        // Route into the existing federated-profile flow keyed by the Oxy user.
        openProfile();
      } else {
        toast(
          t('search.external.followFailed', { defaultValue: 'Could not follow this account' }),
          { type: 'error' },
        );
      }
    } catch {
      toast(
        t('search.external.followFailed', { defaultValue: 'Could not follow this account' }),
        { type: 'error' },
      );
    } finally {
      setPending(false);
    }
  }, [pending, isAuthenticated, showBottomSheet, actor.externalId, openProfile, t]);

  return (
    <TouchableOpacity
      onPress={openProfile}
      activeOpacity={0.7}
      className="bg-card border-border w-full p-4 rounded-xl gap-3"
      style={{ borderWidth: StyleSheet.hairlineWidth }}
    >
      <View className="flex-row items-center gap-3">
        <Avatar source={avatarSource} name={displayName} size={48} />
        <View className="flex-1 gap-1">
          <ThemedText
            className="text-base font-semibold"
            style={{ lineHeight: 20 }}
            numberOfLines={1}
          >
            {displayName}
          </ThemedText>
          <View className="flex-row items-center gap-1">
            <FediverseIcon size={13} color={theme.colors.textSecondary} />
            <ThemedText
              className="text-muted-foreground text-sm"
              style={{ lineHeight: 18 }}
              numberOfLines={1}
            >
              @{actor.handle}
            </ThemedText>
          </View>
          {/* Network badge — names the external network the actor lives on. */}
          <View className="flex-row">
            <View className="bg-secondary rounded-full px-2 py-0.5">
              <ThemedText className="text-muted-foreground text-xs font-medium">
                {networkLabel}
              </ThemedText>
            </View>
          </View>
        </View>
        {/* Stop the press from bubbling to the card's profile-open handler so the
            Follow button is independently tappable (matters on web, where nested
            pressables both fire). */}
        <View onStartShouldSetResponder={() => true} onTouchEnd={stopPropagation}>
          <Button
            variant={following ? 'secondary' : 'primary'}
            size="small"
            onPress={handleFollow}
            disabled={following || pending}
          >
            {following
              ? t('search.external.following', { defaultValue: 'Following' })
              : pending
                ? t('search.external.followingPending', { defaultValue: 'Following…' })
                : t('search.external.follow', { defaultValue: 'Follow' })}
          </Button>
        </View>
      </View>
    </TouchableOpacity>
  );
}
