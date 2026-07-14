import React, { useCallback, useMemo, useState } from 'react';
import { View } from 'react-native';
import { router } from 'expo-router';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { FollowButton, useAuth } from '@oxyhq/services';
import {
  StarterPackCard,
  StarterPackCardSkeleton,
  type StarterPackCardData,
} from '@/components/StarterPackCard';
import {
  starterPacksService,
  type StarterPackSummary,
} from '@/services/starterPacksService';
import { logger } from '@/lib/logger';
import { DismissButton } from './DismissButton';
import { InterstitialShell, type InterstitialItemContext } from './InterstitialShell';
import {
  INTERSTITIAL_STALE_TIME_MS,
  resolveInterstitialLimits,
  selectInterstitialWindow,
  shouldRenderInterstitial,
} from './interstitialLayout';
import { useIsScreenNotMobile } from '@/hooks/useOptimizedMediaQuery';

/**
 * Starter packs, inline in the feed — the one suggestion that fixes an empty
 * follow graph in a single tap, which is why the server leads with it for cold
 * viewers.
 *
 * `excludeUsed` filters out the viewer's own packs and the ones they already
 * used, server-side; the query is therefore gated on private-API readiness, or a
 * cold-boot request would go out anonymous and suggest packs the viewer has
 * already followed through.
 */
export function SuggestedStarterPacksInterstitial({ ordinal }: { ordinal: number }) {
  const { t } = useTranslation();
  const isDesktop = useIsScreenNotMobile();
  const { user, canUsePrivateApi, isPrivateApiPending } = useAuth();
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => new Set());

  const limits = resolveInterstitialLimits('suggestedStarterPacks', isDesktop);

  const query = useQuery({
    // `excludeUsed` makes the list viewer-specific — never share it across an
    // account switch.
    queryKey: ['feedInterstitial', 'suggestedStarterPacks', user?.id ?? 'anon'],
    queryFn: () => starterPacksService.list({ excludeUsed: true }),
    enabled: canUsePrivateApi,
    staleTime: INTERSTITIAL_STALE_TIME_MS,
  });

  // "Follow all" is the FollowButton's job; recording that the pack was USED
  // (which is what ranks packs for everyone else) is ours. Best-effort: a failed
  // usage write must never undo a successful bulk follow.
  const recordUse = useMutation({
    mutationFn: (packId: string) => starterPacksService.use(packId),
    onError: (error, packId) => {
      logger.warn('Feed interstitial: recording starter-pack usage failed', { error, packId });
    },
  });

  const packs = useMemo(
    () =>
      selectInterstitialWindow(
        query.data?.items ?? [],
        ordinal,
        limits,
        starterPackId,
        dismissed,
      ),
    [query.data, ordinal, limits, dismissed],
  );

  const handleDismiss = useCallback((id: string) => {
    setDismissed((prev) => {
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  }, []);

  const handleBulkFollow = useCallback(
    (packId: string) => {
      recordUse.mutate(packId);
    },
    [recordUse],
  );

  const renderItem = useCallback(
    (pack: StarterPackSummary, { isCarousel }: InterstitialItemContext) => (
      <SuggestedStarterPackItem
        pack={pack}
        isCarousel={isCarousel}
        onBulkFollow={handleBulkFollow}
        onDismiss={handleDismiss}
      />
    ),
    [handleBulkFollow, handleDismiss],
  );

  const renderSkeleton = useCallback(
    () => (
      <View className="px-3 pb-2">
        <StarterPackCardSkeleton />
      </View>
    ),
    [],
  );

  if (!canUsePrivateApi && !isPrivateApiPending) return null;

  const isLoading = query.isPending;
  if (!shouldRenderInterstitial(packs.length, isLoading, limits)) return null;

  return (
    <InterstitialShell
      title={t('feed.interstitial.starterPacks.title')}
      seeMoreHref="/explore/starter-packs"
      items={packs}
      keyExtractor={starterPackId}
      renderItem={renderItem}
      limits={limits}
      isLoading={isLoading}
      renderSkeleton={renderSkeleton}
    />
  );
}

function starterPackId(pack: StarterPackSummary): string {
  return String(pack.id || pack._id);
}

interface SuggestedStarterPackItemProps {
  pack: StarterPackSummary;
  isCarousel: boolean;
  onBulkFollow: (packId: string) => void;
  onDismiss: (id: string) => void;
}

/**
 * One suggested pack: the app-wide {@link StarterPackCard} (member faces, name,
 * counts) with a multi-mode FollowButton under it. The button drops the viewer's
 * own id, dedupes, and renders NOTHING when no one is left to follow — so a pack
 * the viewer already follows through shows no dead call-to-action.
 *
 * The X overlays the card because {@link StarterPackCard} has no trailing slot,
 * and it stays a SIBLING of the card's pressable rather than a child of it.
 */
function SuggestedStarterPackItem({
  pack,
  isCarousel,
  onBulkFollow,
  onDismiss,
}: SuggestedStarterPackItemProps) {
  const { t } = useTranslation();

  const id = starterPackId(pack);
  const memberIds = pack.memberOxyUserIds ?? [];
  const memberCount = pack.memberCount ?? memberIds.length;

  const cardData: StarterPackCardData = {
    id,
    name: pack.name,
    description: pack.description,
    creator: pack.creator ?? pack.owner,
    memberCount,
    useCount: pack.useCount ?? 0,
    memberAvatars: pack.memberAvatars ?? [],
    totalMembers: memberCount,
  };

  return (
    <View className={isCarousel ? 'gap-2' : 'gap-2 px-3 pb-2'}>
      <View>
        <StarterPackCard
          pack={cardData}
          onPress={() => router.push(`/starter-packs/${id}`)}
          noDescription={isCarousel}
        />
        <DismissButton
          overlay
          onPress={() => onDismiss(id)}
          accessibilityLabel={t('feed.interstitial.starterPacks.dismiss', { name: pack.name })}
        />
      </View>
      <FollowButton
        userIds={memberIds}
        size="small"
        followAllLabel={t('feed.interstitial.starterPacks.followAll')}
        followedAllLabel={t('feed.interstitial.starterPacks.followingAll')}
        onBulkFollow={() => onBulkFollow(id)}
      />
    </View>
  );
}
