import React, { useCallback, useMemo, useState } from 'react';
import { View } from 'react-native';
import { router } from 'expo-router';
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
import {
  useInterstitialReporter,
  type InterstitialCardProps,
  type ReportInterstitialEvent,
} from './interstitialTelemetry';
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
export function SuggestedUsersInterstitial({
  ordinal,
  slotKey,
  feedDescriptor,
}: InterstitialCardProps) {
  const { t } = useTranslation();
  const isDesktop = useIsScreenNotMobile();
  const { recommendations, isLoading } = useRecommendations();
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => new Set());
  const report = useInterstitialReporter({ feedDescriptor, slotKey, kind: 'suggestedUsers' });

  const limits = resolveInterstitialLimits('suggestedUsers', isDesktop);

  const users = useMemo(
    () => selectInterstitialWindow(recommendations, ordinal, limits, profileId, dismissed),
    [recommendations, ordinal, limits, dismissed],
  );

  const handleDismiss = useCallback(
    (id: string, position: number) => {
      report('dismiss', position);
      setDismissed((prev) => {
        const next = new Set(prev);
        next.add(id);
        return next;
      });
    },
    [report],
  );

  const renderItem = useCallback(
    (profile: ProfileData, { isCarousel, isLast, position }: InterstitialItemContext) => (
      <SuggestedUserItem
        profile={profile}
        isCarousel={isCarousel}
        isLast={isLast}
        position={position}
        report={report}
        onDismiss={handleDismiss}
      />
    ),
    [report, handleDismiss],
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
      report={report}
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
  /** 0-based index within the band — the `position` every item event carries. */
  position: number;
  report: ReportInterstitialEvent;
  onDismiss: (id: string, position: number) => void;
}

/**
 * One suggested account: the app-wide {@link ProfileCard} row, with the X as its
 * trailing accessory. In the carousel the row loses its divider and sits on a
 * card surface; in the vertical list it stays the flush, feed-consistent row it
 * is everywhere else.
 */
function SuggestedUserItem({
  profile,
  isCarousel,
  isLast,
  position,
  report,
  onDismiss,
}: SuggestedUserItemProps) {
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
      // Reports the tap, then does exactly what the row does by default. Only
      // wired when there IS somewhere to go: a handle-less (degraded) profile is
      // not pressable, and must not become so just because we want the signal.
      onPress={
        handle.length > 0
          ? () => {
              report('click', position);
              router.push(`/@${handle}`);
            }
          : undefined
      }
      showFollowButton
      onFollowChange={(isFollowing) => {
        // An unfollow is not a follow — the band measures accounts GAINED.
        if (isFollowing) report('follow', position);
      }}
      showDivider={!isCarousel && !isLast}
      accessory={
        <DismissButton
          onPress={() => onDismiss(profile.id, position)}
          accessibilityLabel={dismissLabel}
        />
      }
    />
  );

  if (!isCarousel) return row;

  return <View className="bg-card flex-1 justify-center overflow-hidden rounded-xl">{row}</View>;
}
