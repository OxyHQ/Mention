import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ProfileCardData } from '@/components/ProfileCard';
import { SuggestedProfileCardSkeleton } from '@/components/SuggestedProfileCard';
import { useRecommendations } from '@/hooks/useRecommendations';
import type { ProfileData } from '@/lib/recommendations';
import { PersonSuggestionItem } from './PersonSuggestionItem';
import { InterstitialShell } from './InterstitialShell';
import {
  INTERSTITIAL_CARD_WIDTH,
  resolveInterstitialLimits,
  selectInterstitialWindow,
  shouldRenderInterstitial,
} from './interstitialLayout';
import { useInterstitialReporter, type InterstitialCardProps } from './interstitialTelemetry';

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
  const { recommendations, isLoading } = useRecommendations();
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => new Set());
  const report = useInterstitialReporter({ feedDescriptor, slotKey, kind: 'suggestedUsers' });

  const limits = resolveInterstitialLimits('suggestedUsers');

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
    (profile: ProfileData, position: number) => (
      <PersonSuggestionItem
        profile={toCardData(profile)}
        dismissLabelKey="feed.interstitial.users.dismiss"
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
      isLoading={isLoading}
      renderSkeleton={renderSkeleton}
      report={report}
    />
  );
}

function profileId(profile: ProfileData): string {
  return profile.id;
}

/** The tile's view of a recommended profile. */
function toCardData(profile: ProfileData): ProfileCardData {
  return {
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
}
