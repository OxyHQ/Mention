import React, { useCallback, useEffect, useMemo } from 'react';
import { Platform, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import * as Skeleton from '@oxyhq/bloom/skeleton';
import { show as toast } from '@oxyhq/bloom/toast';
import { useTranslation } from 'react-i18next';
import { useRouter } from 'expo-router';
import { BaseWidget } from './BaseWidget';
import { useTrendsStore } from '@/store/trendsStore';
import type { Trend } from '@/interfaces/Trend';
import { useTrendNavigation, buildTrendUrl } from '@/hooks/useTrendNavigation';
import { useWidgetItemMenu } from '@/hooks/useWidgetItemMenu';
import { shareLink } from '@/utils/shareLink';
import { TrendItemRow } from '@/components/trending/TrendItemRow';

const MAX_TRENDS_DISPLAYED = 5;
const TRENDING_ROUTE = '/explore/trending';

interface TrendsWidgetProps {
  variant?: 'card' | 'inline';
}

export function TrendsWidget({ variant = 'card' }: TrendsWidgetProps) {
  const { t } = useTranslation();
  const { trends, summary, isLoading, hasFetched, error, hiddenTrendIds, startPolling, hideTrend } =
    useTrendsStore();
  const router = useRouter();
  const openWidgetMenu = useWidgetItemMenu();

  useEffect(() => {
    startPolling();
  }, [startPolling]);

  const { navigateToTrend } = useTrendNavigation();

  const visibleTrends = useMemo(
    () => (trends || []).filter((trend) => !hiddenTrendIds.includes(trend.id)),
    [trends, hiddenTrendIds],
  );

  const handleMorePress = useCallback(() => {
    router.push(TRENDING_ROUTE);
  }, [router]);

  const handleMenuPress = useCallback(
    (trend: Trend) => {
      const trendName = trend.type === 'hashtag' ? `#${(trend.hashtag || trend.text).replace(/^#/, '')}` : trend.text;
      openWidgetMenu({
        title: trendName,
        onNotInterested: () => {
          hideTrend(trend.id);
          toast(t('widgetMenu.trendHidden'), { type: 'success' });
        },
        onShare: () => {
          void shareLink({
            title: trendName,
            url: buildTrendUrl(trend),
            copiedToast: t('widgetMenu.linkCopied'),
            errorToast: t('widgetMenu.shareFailed'),
          });
        },
      });
    },
    [openWidgetMenu, hideTrend, t],
  );

  if (hasFetched && !error && visibleTrends.length === 0) {
    return null;
  }

  const content = (isLoading && !hasFetched) ? (
    <View className="gap-2.5 py-1">
      {Array.from({ length: 5 }).map((_, i) => (
        <Skeleton.Row key={i} style={{ alignItems: 'center', justifyContent: 'space-between' }}>
          <Skeleton.Col>
            <Skeleton.Text style={{ fontSize: 12, lineHeight: 14, width: 120 }} />
            <Skeleton.Text style={{ fontSize: 14, lineHeight: 16, width: 160 }} />
          </Skeleton.Col>
          <Skeleton.Pill size={14} />
        </Skeleton.Row>
      ))}
    </View>
  ) : error ? (
    <Text className="text-destructive">{t('error.fetch_trends')}</Text>
  ) : (
    <View className="gap-2">
      <View>
        {summary ? (
          <Text className="text-muted-foreground text-[12px] mb-1 leading-4" numberOfLines={2}>
            {summary}
          </Text>
        ) : null}
        {visibleTrends.slice(0, MAX_TRENDS_DISPLAYED).map((trend: Trend, index: number) => {
          const isLast = index === Math.min(visibleTrends.length, MAX_TRENDS_DISPLAYED) - 1;
          return (
            <TrendItemRow
              key={trend.id}
              trend={trend}
              onPress={navigateToTrend}
              onMenuPress={handleMenuPress}
              showBorder={!isLast}
            />
          );
        })}
      </View>
      <TouchableOpacity
        style={styles.webCursor}
        onPress={handleMorePress}
        activeOpacity={0.7}
      >
        <Text className="text-primary text-[14px] font-medium">
          Show more
        </Text>
      </TouchableOpacity>
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
    <BaseWidget title={t('Trending')}>
      {content}
    </BaseWidget>
  );
}

const styles = StyleSheet.create({
  webCursor: Platform.select({ web: { cursor: 'pointer' }, default: {} }),
});
