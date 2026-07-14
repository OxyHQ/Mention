import React, { useCallback, useMemo, useState } from 'react';
import { View } from 'react-native';
import { router } from 'expo-router';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@oxyhq/services';
import { show as toast } from '@oxyhq/bloom/toast';
import { FeedCard, FeedCardSkeleton, type FeedCardData } from '@/components/FeedCard';
import { FeedSubscribeButton } from '@/components/FeedSubscribeButton';
import {
  customFeedsService,
  type MarketplaceFeed,
} from '@/services/customFeedsService';
import { logger } from '@/lib/logger';
import { DismissButton } from './DismissButton';
import { InterstitialShell, type InterstitialItemContext } from './InterstitialShell';
import {
  INTERSTITIAL_STALE_TIME_MS,
  SUGGESTED_FEEDS_FETCH_LIMIT,
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
 * Custom feeds the viewer does not already read, inline in the feed.
 *
 * `excludeSubscribed` does the "don't suggest what I already have" filtering
 * server-side, where the subscription rows live — which is also why the query is
 * gated on the viewer's private-API readiness: sent during a cold-boot SSO
 * restore the request would be anonymous, the exclusion would be silently
 * ignored, and the band would recommend feeds the viewer already subscribes to.
 */
export function SuggestedFeedsInterstitial({
  ordinal,
  slotKey,
  feedDescriptor,
}: InterstitialCardProps) {
  const { t } = useTranslation();
  const isDesktop = useIsScreenNotMobile();
  const { user, canUsePrivateApi, isPrivateApiPending } = useAuth();
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => new Set());
  const [subscribed, setSubscribed] = useState<ReadonlySet<string>>(() => new Set());
  const report = useInterstitialReporter({ feedDescriptor, slotKey, kind: 'suggestedFeeds' });

  const limits = resolveInterstitialLimits('suggestedFeeds', isDesktop);

  const query = useQuery({
    // Keyed on the viewer: `excludeSubscribed` makes this list viewer-specific,
    // so it must never be shared across an account switch.
    queryKey: ['feedInterstitial', 'suggestedFeeds', user?.id ?? 'anon'],
    queryFn: () =>
      customFeedsService.getMarketplace({
        excludeSubscribed: true,
        limit: SUGGESTED_FEEDS_FETCH_LIMIT,
      }),
    enabled: canUsePrivateApi,
    staleTime: INTERSTITIAL_STALE_TIME_MS,
  });

  // The subscription is carried out by feed id; the band ALSO carries the item's
  // position so the reported event can say WHERE in the card the viewer acted.
  const subscribe = useMutation({
    mutationFn: ({ feedId }: SubscribeTarget) => customFeedsService.likeFeed(feedId),
    onSuccess: (_result, { feedId, position }) => {
      // Reported on success, not on press: a subscription that failed is not one.
      report('subscribe', position);
      setSubscribed((prev) => {
        const next = new Set(prev);
        next.add(feedId);
        return next;
      });
    },
    onError: (error, { feedId }) => {
      logger.warn('Feed interstitial: subscribe failed', { error, feedId });
      toast(t('feed.interstitial.feeds.subscribeError'), { type: 'error' });
    },
  });

  const feeds = useMemo(
    () =>
      selectInterstitialWindow(
        query.data?.items ?? [],
        ordinal,
        limits,
        marketplaceFeedId,
        dismissed,
      ),
    [query.data, ordinal, limits, dismissed],
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

  const handleSubscribe = useCallback(
    (target: SubscribeTarget) => {
      subscribe.mutate(target);
    },
    [subscribe],
  );

  const renderItem = useCallback(
    (feed: MarketplaceFeed, { isCarousel, position }: InterstitialItemContext) => {
      const id = marketplaceFeedId(feed);
      return (
        <SuggestedFeedItem
          feed={feed}
          isCarousel={isCarousel}
          position={position}
          isSubscribed={subscribed.has(id) || feed.isLiked === true}
          isSubscribing={subscribe.isPending && subscribe.variables?.feedId === id}
          report={report}
          onSubscribe={handleSubscribe}
          onDismiss={handleDismiss}
        />
      );
    },
    [
      subscribed,
      subscribe.isPending,
      subscribe.variables,
      report,
      handleSubscribe,
      handleDismiss,
    ],
  );

  const renderSkeleton = useCallback(() => <FeedCardSkeleton />, []);

  // The session is settled and anonymous: the server never plans a band for an
  // anonymous viewer, so this only happens if one slips through. Show nothing.
  if (!canUsePrivateApi && !isPrivateApiPending) return null;

  const isLoading = query.isPending;
  if (!shouldRenderInterstitial(feeds.length, isLoading, limits)) return null;

  return (
    <InterstitialShell
      title={t('feed.interstitial.feeds.title')}
      seeMoreHref="/feeds/marketplace"
      items={feeds}
      keyExtractor={marketplaceFeedId}
      renderItem={renderItem}
      limits={limits}
      isLoading={isLoading}
      renderSkeleton={renderSkeleton}
      report={report}
    />
  );
}

/** The marketplace normalizes `_id` to `id`; both are read for safety. */
function marketplaceFeedId(feed: MarketplaceFeed): string {
  return String(feed.id || feed._id);
}

/** Which feed to subscribe to, and where in the band the viewer pressed. */
interface SubscribeTarget {
  feedId: string;
  position: number;
}

interface SuggestedFeedItemProps {
  feed: MarketplaceFeed;
  isCarousel: boolean;
  /** 0-based index within the band — the `position` every item event carries. */
  position: number;
  isSubscribed: boolean;
  isSubscribing: boolean;
  report: ReportInterstitialEvent;
  onSubscribe: (target: SubscribeTarget) => void;
  onDismiss: (id: string, position: number) => void;
}

/**
 * One suggested feed: the app-wide {@link FeedCard} with Subscribe and the X in
 * its `headerRight` slot. The carousel gets the rounded `card` surface, the
 * vertical list the flush `row` — the two variants the card already ships.
 */
function SuggestedFeedItem({
  feed,
  isCarousel,
  position,
  isSubscribed,
  isSubscribing,
  report,
  onSubscribe,
  onDismiss,
}: SuggestedFeedItemProps) {
  const { t } = useTranslation();
  const id = marketplaceFeedId(feed);

  const cardData: FeedCardData = {
    id,
    displayName: feed.title,
    description: feed.description,
    creator: feed.owner
      ? {
          username: feed.owner.username ?? '',
          displayName: feed.owner.displayName,
          avatar: feed.owner.avatar,
        }
      : undefined,
    memberCount: feed.memberCount,
    topicCount: feed.topicCount,
  };

  return (
    <FeedCard
      feed={cardData}
      variant={isCarousel ? 'card' : 'row'}
      showDescription
      // Reports the tap, then opens the feed exactly as the card does by default.
      onPress={() => {
        report('click', position);
        router.push(`/feeds/${id}`);
      }}
      headerRight={
        <View className="flex-row items-center gap-1">
          <FeedSubscribeButton
            isSubscribed={isSubscribed}
            isSubscribing={isSubscribing}
            onPress={() => onSubscribe({ feedId: id, position })}
          />
          <DismissButton
            onPress={() => onDismiss(id, position)}
            accessibilityLabel={t('feed.interstitial.feeds.dismiss', { name: feed.title })}
          />
        </View>
      }
    />
  );
}
