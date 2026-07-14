import React, { useCallback, useMemo, useState } from 'react';
import { View } from 'react-native';
import { useTranslation } from 'react-i18next';
import {
  ProfileCard,
  ProfileCardSkeleton,
  type ProfileCardData,
} from '@/components/ProfileCard';
import { useRecommendations } from '@/hooks/useRecommendations';
import type { ProfileData } from '@/lib/recommendations';
import { getNormalizedUserHandle } from '@oxyhq/core';
import { DismissButton } from './DismissButton';
import { InterstitialShell, type InterstitialItemContext } from './InterstitialShell';
import {
  resolveInterstitialLimits,
  selectInterstitialWindow,
  shouldRenderInterstitial,
} from './interstitialLayout';
import { useIsScreenNotMobile } from '@/hooks/useOptimizedMediaQuery';

/**
 * "Who to follow", inline in the feed.
 *
 * Reads the SAME single-page recommendations cache the right-rail widget owns
 * (`useRecommendations`, one 50-profile page keyed by viewer + filters), so on
 * desktop — where the rail has already warmed it — the band costs zero extra
 * requests, and on mobile the first band pays for every band after it. That one
 * page is also deep enough to give each band its own slice: `ordinal` offsets
 * into it, so the second card in a scroll session never shows the first card's
 * faces.
 */
export function SuggestedUsersInterstitial({ ordinal }: { ordinal: number }) {
  const { t } = useTranslation();
  const isDesktop = useIsScreenNotMobile();
  const { recommendations, isLoading } = useRecommendations();
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => new Set());

  const limits = resolveInterstitialLimits('suggestedUsers', isDesktop);

  const users = useMemo(
    () => selectInterstitialWindow(recommendations, ordinal, limits, profileId, dismissed),
    [recommendations, ordinal, limits, dismissed],
  );

  const handleDismiss = useCallback((id: string) => {
    setDismissed((prev) => {
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  }, []);

  const renderItem = useCallback(
    (profile: ProfileData, { isCarousel, isLast }: InterstitialItemContext) => (
      <SuggestedUserItem
        profile={profile}
        isCarousel={isCarousel}
        isLast={isLast}
        onDismiss={handleDismiss}
      />
    ),
    [handleDismiss],
  );

  const renderSkeleton = useCallback(() => <ProfileCardSkeleton showFollowButton />, []);

  if (!shouldRenderInterstitial(users.length, isLoading, limits)) return null;

  return (
    <InterstitialShell
      title={t('feed.interstitial.users.title')}
      seeMoreHref="/explore/who-to-follow"
      items={users}
      keyExtractor={profileId}
      renderItem={renderItem}
      limits={limits}
      isLoading={isLoading}
      renderSkeleton={renderSkeleton}
    />
  );
}

function profileId(profile: ProfileData): string {
  return profile.id;
}

interface SuggestedUserItemProps {
  profile: ProfileData;
  isCarousel: boolean;
  isLast: boolean;
  onDismiss: (id: string) => void;
}

/**
 * One suggested account: the app-wide {@link ProfileCard} row, with the X as its
 * trailing accessory. In the carousel the row loses its divider and sits on a
 * card surface; in the vertical list it stays the flush, feed-consistent row it
 * is everywhere else.
 */
function SuggestedUserItem({ profile, isCarousel, isLast, onDismiss }: SuggestedUserItemProps) {
  const { t } = useTranslation();

  // Same degradation ladder the row itself renders: display name, else @handle,
  // else "Unknown user" — an unresolved profile must never leak its raw id, not
  // even into a screen reader.
  const handle = getNormalizedUserHandle(profile) ?? '';
  const dismissLabel = t('feed.interstitial.users.dismiss', {
    name:
      profile.name?.displayName?.trim() ||
      (handle.length > 0 ? `@${handle}` : t('user.unknown')),
  });

  const cardData: ProfileCardData = {
    id: profile.id,
    username: profile.username,
    name: profile.name,
    avatar: profile.avatar,
    verified: profile.verified,
    // The carousel card has no room for a bio; the wide desktop row does.
    description: isCarousel ? undefined : (profile.description ?? profile.bio),
    isFederated: profile.isFederated,
    isAgent: profile.isAgent,
    isAutomated: profile.isAutomated,
    instance: profile.instance,
    federation: profile.federation,
  };

  const row = (
    <ProfileCard
      profile={cardData}
      showFollowButton
      showDivider={!isCarousel && !isLast}
      accessory={
        <DismissButton
          onPress={() => onDismiss(profile.id)}
          accessibilityLabel={dismissLabel}
        />
      }
    />
  );

  if (!isCarousel) return row;

  return <View className="bg-surface flex-1 justify-center overflow-hidden rounded-xl">{row}</View>;
}
