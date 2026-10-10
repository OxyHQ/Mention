import { Button } from '@oxy.so/bloom/button';
import React, { useCallback, useEffect, useMemo } from 'react';
import { View } from 'react-native';
import { Text } from '@oxy.so/bloom/typography';
import { useTheme } from '@oxy.so/bloom/theme';
import * as Skeleton from '@oxy.so/bloom/skeleton';
import { useTranslation } from 'react-i18next';
import { useRouter } from 'expo-router';
import { BaseWidget } from './BaseWidget';
import { useTrendsStore } from '@/stores/trendsStore';
import type { Trend } from '@/interfaces/Trend';
import { useTrendNavigation } from '@/hooks/useTrendNavigation';
import { useTrendItemMenu } from '@/hooks/useTrendItemMenu';
import { TrendItemRow, TrendItemRowSkeleton } from '@/components/trending/TrendItemRow';

const MAX_TRENDS_DISPLAYED = 5;
/** Height of the small plain "Show more" button (Bloom `Button size="small"`). */
const SHOW_MORE_HEIGHT = 32;
const TRENDING_ROUTE = '/explore/trending';

interface TrendsWidgetProps {
  variant?: 'card' | 'inline';
  divider?: boolean;
}

export function TrendsWidget({ variant = 'card', divider }: TrendsWidgetProps) {
  const { t } = useTranslation();
  const { trends, summary, hasFetched, error, hiddenTrendIds, startPolling, stopPolling } =
    useTrendsStore();
  const router = useRouter();
  const theme = useTheme();
  const handleMenuPress = useTrendItemMenu();

  useEffect(() => {
    const subscriptionId = startPolling();
    return () => stopPolling(subscriptionId);
  }, [startPolling, stopPolling]);

  const { navigateToTrend } = useTrendNavigation();

  const visibleTrends = useMemo(
    () => (trends || []).filter((trend) => !hiddenTrendIds.includes(trend.id)),
    [trends, hiddenTrendIds],
  );

  const handleMorePress = useCallback(() => {
    router.push(TRENDING_ROUTE);
  }, [router]);

  // The rendered position travels with the press so the metric can say WHERE in
  // the widget readers actually press — `visibleTrends` is already filtered and
  // capped, so this is the position the reader saw, not the batch-wide rank.
  const handleTrendPress = useCallback(
    (trend: Trend) => {
      const position = visibleTrends.findIndex((candidate) => candidate.id === trend.id);
      navigateToTrend(trend, 'widget', position >= 0 ? position + 1 : undefined);
    },
    [navigateToTrend, visibleTrends],
  );

  // A failed fetch is settled too: the widget has nothing to say, so it says
  // nothing rather than turning the rail into an error report. Trends that are
  // already on screen survive a later failure — they are stale, not wrong.
  const hasSettled = hasFetched || error !== null;

  if (hasSettled && visibleTrends.length === 0) {
    return null;
  }

  // The placeholder has the loaded list's shape — the same five rows and the
  // "Show more" button below them — so the widgets under this one stay put
  // when the trends arrive.
  const content = !hasSettled ? (
    <View className="gap-2">
      <View>
        {Array.from({ length: MAX_TRENDS_DISPLAYED }).map((_, i) => (
          <TrendItemRowSkeleton key={i} showBorder={i < MAX_TRENDS_DISPLAYED - 1} />
        ))}
      </View>
      <Skeleton.Box width={88} height={SHOW_MORE_HEIGHT} borderRadius={SHOW_MORE_HEIGHT / 2} />
    </View>
  ) : (
    <View className="gap-2">
      <View>
        {summary ? (
          <Text
            variant="caption-1-regular"
            style={{ marginBottom: 4, color: theme.colors.textSecondary }}
            numberOfLines={2}
          >
            {summary}
          </Text>
        ) : null}
        {visibleTrends.slice(0, MAX_TRENDS_DISPLAYED).map((trend: Trend, index: number) => {
          const isLast = index === Math.min(visibleTrends.length, MAX_TRENDS_DISPLAYED) - 1;
          return (
            <TrendItemRow
              key={trend.id}
              trend={trend}
              // Position in what the reader actually sees — this list is capped
              // at five and has the hidden trends filtered out of it, so the
              // batch-wide `trend.rank` would show gaps here.
              ordinal={index + 1}
              onPress={handleTrendPress}
              onMenuPress={handleMenuPress}
              showBorder={!isLast}
            />
          );
        })}
      </View>
      <Button
        appearance="plain"
        size="sm"
        onPress={handleMorePress}
        style={{ alignSelf: 'flex-start' }}
      >
        Show more
      </Button>
    </View>
  );

  if (variant === 'inline') {
    return (
      <View className="px-4 pt-3 pb-2 border-b border-border">
        <Text className="text-[15px] font-bold text-foreground mb-1">{t('Trending')}</Text>
        {content}
      </View>
    );
  }

  return (
    <BaseWidget title={t('Trending')} divider={divider}>
      {content}
    </BaseWidget>
  );
}
