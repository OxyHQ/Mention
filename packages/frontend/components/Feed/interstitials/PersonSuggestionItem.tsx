import React from 'react';
import { router } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { getNormalizedUserHandle } from '@oxy.so/core';
import type { ProfileCardData } from '@/components/ProfileCard';
import { profileHrefForUser } from '@/components/Profile/profileRoute';
import { SuggestedProfileCard } from '@/components/SuggestedProfileCard';
import { DismissButton } from './DismissButton';
import type { ReportInterstitialEvent } from './interstitialTelemetry';

interface PersonSuggestionItemProps {
  profile: ProfileCardData;
  /** The band's "Dismiss {{name}}" key — each band names its own X. */
  dismissLabelKey: string;
  /** 0-based index within the band — the `position` every item event carries. */
  position: number;
  report: ReportInterstitialEvent;
  onDismiss: (id: string, position: number) => void;
}

/**
 * One suggested account in a people band ("Who to follow", "Similar
 * accounts"): the {@link SuggestedProfileCard} person tile, with the X in its
 * corner, reporting what the reader does to it.
 */
export function PersonSuggestionItem({
  profile,
  dismissLabelKey,
  position,
  report,
  onDismiss,
}: PersonSuggestionItemProps) {
  const { t } = useTranslation();

  // Same degradation ladder the tile itself renders: display name, else
  // @handle, else "Unknown user" — an unresolved profile must never leak its raw
  // id, not even into a screen reader.
  const handle = getNormalizedUserHandle(profile) ?? '';
  const profileHref = profileHrefForUser(profile);
  const dismissLabel = t(dismissLabelKey, {
    name:
      profile.name?.displayName?.trim() ||
      (handle.length > 0 ? `@${handle}` : t('user.unknown')),
  });

  return (
    <SuggestedProfileCard
      profile={profile}
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
