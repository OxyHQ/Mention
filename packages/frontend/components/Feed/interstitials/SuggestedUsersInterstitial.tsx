import React, { useCallback, useMemo, useState } from 'react';
import { router } from 'expo-router';
import { useTranslation } from 'react-i18next';
import type { ProfileCardData } from '@/components/ProfileCard';
import {
  SuggestedProfileCard,
  SuggestedProfileCardSkeleton,
} from '@/components/SuggestedProfileCard';
import { useRecommendations } from '@/hooks/useRecommendations';
import type { ProfileData } from '@/lib/recommendations';
import { getNormalizedUserHandle } from '@oxy.so/core';
import { profileHrefForUser } from '@/components/Profile/profileRoute';
import { DismissButton } from './DismissButton';
import { InterstitialShell, type InterstitialItemContext } from './InterstitialShell';
import {
  INTERSTITIAL_CARD_WIDTH,
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
    (profile: ProfileData, { position }: InterstitialItemContext) => (
      <SuggestedUserItem
        profile={profile}
        position={position}
        report={report}
        onDismiss={handleDismiss}
      />
    ),
    [report, handleDismiss],
  );

  const renderSkeleton = useCallback(() => <SuggestedProfileCardSkeleton />, []);

  if (!shouldRenderInterstitial(users.length, isLoading, limits)) return null;

  return (
    <InterstitialShell
      title={t('feed.interstitial.users.title')}
      seeMoreHref="/explore/who-to-follow"
      items={users}
      keyExtractor={profileId}
      cardWidth={INTERSTITIAL_CARD_WIDTH.profile}
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
  /** 0-based index within the band — the `position` every item event carries. */
  position: number;
  report: ReportInterstitialEvent;
  onDismiss: (id: string, position: number) => void;
}

/**
 * One suggested account: the {@link SuggestedProfileCard} person tile, with the
 * X in its corner.
 */
function SuggestedUserItem({
  profile,
  position,
  report,
  onDismiss,
}: SuggestedUserItemProps) {
  const { t } = useTranslation();

  // Same degradation ladder the row itself renders: display name, else @handle,
  // else "Unknown user" — an unresolved profile must never leak its raw id, not
  // even into a screen reader.
  const handle = getNormalizedUserHandle(profile) ?? '';
  const profileHref = profileHrefForUser(profile);
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
    description: profile.description ?? profile.bio,
    isFederated: profile.isFederated,
    isAgent: profile.isAgent,
    isAutomated: profile.isAutomated,
    instance: profile.instance,
    federation: profile.federation,
  };

  return (
    <SuggestedProfileCard
      profile={cardData}
      // Reports the tap, then does exactly what the tile does by default. Only
      // wired when there IS somewhere to go: a handle-less (degraded) profile is
      // not pressable, and must not become so just because we want the signal.
      onPress={
        profileHref
          ? () => {
              report('click', position);
              router.push(profileHref);
            }
          : undefined
      }
      onFollowChange={(isFollowing) => {
        // An unfollow is not a follow — the band measures accounts GAINED.
        if (isFollowing) report('follow', position);
      }}
      accessory={
        <DismissButton
          overlay
          onPress={() => onDismiss(profile.id, position)}
          accessibilityLabel={dismissLabel}
        />
      }
    />
  );
}
