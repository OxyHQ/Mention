/**
 * Portions adapted from bluesky-social/social-app, MIT © 2023–2026 Bluesky
 * Social PBC — the card's shape (a short numbered list of trends with a way
 * through to the full screen) follows their `FeedTrendingTopics.tsx`
 * (commit c71a4f836). Everything else is Mention's: the band frame is
 * `InterstitialShell`, the rows are the app-wide `TrendItemRow`, and the data
 * comes from the global trends store rather than a query of its own.
 */

import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import { View } from 'react-native';
import * as Skeleton from '@oxyhq/bloom/skeleton';
import { useTranslation } from 'react-i18next';
import type { Trend } from '@/interfaces/Trend';
import { useTrendsStore } from '@/stores/trendsStore';
import { useTrendItemMenu } from '@/hooks/useTrendItemMenu';
import { useTrendNavigation } from '@/hooks/useTrendNavigation';
import { TrendItemRow } from '@/components/trending/TrendItemRow';
import { reportTrendEvent } from '@/utils/feedTelemetry';
import { useIsScreenNotMobile } from '@/hooks/useOptimizedMediaQuery';
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

/** Where the band's "See more" leads — the full trending screen. */
const TRENDING_ROUTE = '/explore/trending';

/**
 * What is trending, inline in the feed.
 *
 * The one band that needs NO fetch of its own: `useTrendsStore` is already
 * global, socket-driven and polled, so the trends are usually in memory before
 * this card mounts. It still takes a polling lease on mount (the leases are
 * ref-counted by id, so mounting and unmounting inside a virtualized list is
 * safe) — otherwise a session that never opens a surface with the right rail
 * would have an empty store and the card would silently never render.
 *
 * It is planned for COLD and WARM follow graphs only (see
 * `MtnConfig.feed.interstitials.rotation`): a reader who follows almost nobody
 * has nothing in Following, and trends are the one discovery surface that works
 * with no graph at all.
 *
 * KNOWN LIMITATION, deliberate: `planInterstitials` is gated on `currentUserId`
 * so nothing personalized can reach the shared `anonFeedCache`. Trends would be
 * perfectly valid for an anonymous reader, but that gate protects a shared cache
 * and is not worth relaxing for one card.
 */
export function TrendingTopicsInterstitial({
  ordinal,
  slotKey,
  feedDescriptor,
}: InterstitialCardProps) {
  const { t } = useTranslation();
  const isDesktop = useIsScreenNotMobile();
  const { navigateToTrend } = useTrendNavigation();
  const handleMenuPress = useTrendItemMenu();

  const allTrends = useTrendsStore((state) => state.trends);
  const hiddenTrendIds = useTrendsStore((state) => state.hiddenTrendIds);
  const isStoreLoading = useTrendsStore((state) => state.isLoading);
  const hasFetched = useTrendsStore((state) => state.hasFetched);
  const startPolling = useTrendsStore((state) => state.startPolling);
  const stopPolling = useTrendsStore((state) => state.stopPolling);

  useEffect(() => {
    const subscriptionId = startPolling();
    return () => stopPolling(subscriptionId);
  }, [startPolling, stopPolling]);

  const report = useInterstitialReporter({ feedDescriptor, slotKey, kind: 'trendingTopics' });
  const limits = resolveInterstitialLimits('trendingTopics', isDesktop);

  // Trends the reader hid are fed to the window as "dismissed", so the band
  // backfills from deeper in the pool instead of shrinking — the same treatment
  // every other band gives a dismissal, using the store's own hidden set.
  const hidden = useMemo(() => new Set(hiddenTrendIds), [hiddenTrendIds]);
  const trends = useMemo(
    () => selectInterstitialWindow(allTrends, ordinal, limits, trendKey, hidden),
    [allTrends, ordinal, limits, hidden],
  );

  // Read at report time, never during render, so the reporter below can stay
  // identity-stable while still seeing what is on screen right now.
  const renderedRef = useRef<Trend[]>(trends);
  renderedRef.current = trends;

  /**
   * The band's reporter, with one addition: when the shell reports the card's
   * `impression` — which it does from a real visibility measurement, not from
   * mount — each trend in the card is ALSO reported as `seen` on the trend
   * endpoint.
   *
   * That is what makes the trend metric readable: a click count with no
   * denominator says nothing, and the click/seen ratio is the measurement. It
   * rides the card's own impression rather than a mount effect so a card the
   * reader flings past is not counted as seen.
   */
  const reportCardEvent = useCallback<ReportInterstitialEvent>(
    (event, position) => {
      report(event, position);
      if (event !== 'impression') return;
      renderedRef.current.forEach((trend, index) => {
        reportTrendEvent({
          event: 'seen',
          type: trend.type,
          surface: 'interstitial',
          rank: index + 1,
          ...(trend.recId ? { recId: trend.recId } : {}),
        });
      });
    },
    [report],
  );

  const renderItem = useCallback(
    (trend: Trend, { position }: InterstitialItemContext) => (
      <TrendItemRow
        trend={trend}
        ordinal={position + 1}
        onPress={() => {
          // Both endpoints, on purpose: the card click compares this card
          // against the other card kinds, the trend click compares this surface
          // against the other places a trend is shown.
          reportCardEvent('click', position);
          navigateToTrend(trend, 'interstitial', position + 1);
        }}
        onMenuPress={handleMenuPress}
        size="large"
      />
    ),
    [reportCardEvent, navigateToTrend, handleMenuPress],
  );

  const renderSkeleton = useCallback(
    () => (
      <View className="px-3 py-2">
        <Skeleton.Col>
          <Skeleton.Text style={{ fontSize: 13, lineHeight: 15, width: 110 }} />
          <Skeleton.Text style={{ fontSize: 16, lineHeight: 18, width: 150 }} />
        </Skeleton.Col>
      </View>
    ),
    [],
  );

  const isLoading = isStoreLoading && !hasFetched;
  if (!shouldRenderInterstitial(trends.length, isLoading, limits)) return null;

  return (
    <InterstitialShell
      title={t('feed.interstitial.trends.title')}
      seeMoreHref={TRENDING_ROUTE}
      items={trends}
      keyExtractor={trendKey}
      renderItem={renderItem}
      limits={limits}
      isLoading={isLoading}
      renderSkeleton={renderSkeleton}
      report={reportCardEvent}
    />
  );
}

/** Stable identity of a trend within the band. */
function trendKey(trend: Trend): string {
  return trend.id;
}
