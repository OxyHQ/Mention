import React, { useCallback, useEffect, memo } from 'react';
import { Platform, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import * as Skeleton from '@oxyhq/bloom/skeleton';
import { useTranslation } from 'react-i18next';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import Svg, { Polyline } from 'react-native-svg';
import { BaseWidget } from './BaseWidget';
import { useTrendsStore } from '@/store/trendsStore';
import { useTheme } from '@oxyhq/bloom/theme';
import { formatCompactNumber } from '@/utils/formatNumber';
import type { Trend } from '@/interfaces/Trend';
import { logger } from '@/lib/logger';

const MAX_TRENDS_DISPLAYED = 5;

const SPARKLINE_POINTS = {
  up: '0,20 10,15 20,18 30,12 40,8 50,5',
  down: '0,5 10,8 20,12 30,18 40,15 50,20',
  flat: '0,12 10,13 20,12 30,13 40,12 50,13',
} as const;

const Sparkline = memo(function Sparkline({
  direction,
  color
}: {
  direction?: 'up' | 'down' | 'flat';
  color: string;
}) {
  const points = SPARKLINE_POINTS[direction || 'flat'];

  return (
    <Svg width="50" height="24" viewBox="0 0 50 24">
      <Polyline
        points={points}
        fill="none"
        stroke={color}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
});

function getTrendLabel(trend: Trend): string {
  if (trend.type === 'hashtag' && trend.volume > 0) {
    return `Trending · ${formatCompactNumber(trend.volume)} posts`;
  }
  if (trend.type === 'entity') return 'Trending';
  if (trend.type === 'topic') return 'Trending topic';
  return 'Trending';
}

function getTrendDisplayName(trend: Trend): string {
  if (trend.type === 'hashtag') {
    const tag = trend.hashtag || trend.text;
    return `#${tag?.replace(/^#/, '')}`;
  }
  return trend.text;
}

interface TrendsWidgetProps {
  variant?: 'card' | 'inline';
}

export function TrendsWidget({ variant = 'card' }: TrendsWidgetProps) {
  const { t } = useTranslation();
  const { trends, summary, isLoading, error, fetchTrends } = useTrendsStore();
  const router = useRouter();
  const theme = useTheme();

  useEffect(() => {
    fetchTrends();
    const id = setInterval(() => fetchTrends({ silent: true }), 60000);
    return () => clearInterval(id);
  }, [fetchTrends]);

  const handleTrendPress = useCallback((trend: Trend) => {
    if (trend.type === 'hashtag') {
      const tag = trend.hashtag || trend.text;
      const href = `/search/%23${encodeURIComponent(tag?.replace(/^#/, ''))}`;
      router.push(href as any);
    } else {
      const href = `/search/${encodeURIComponent(trend.text)}`;
      router.push(href as any);
    }
  }, [router]);

  const handleMorePress = useCallback(() => {
    router.push('/trending' as any);
  }, [router]);

  const handleMenuPress = useCallback((trend: Trend) => {
    logger.debug(`Menu pressed for trend: ${trend.text}`);
  }, []);

  if (!isLoading && !error && (!trends || trends.length === 0)) {
    return null;
  }

  const content = isLoading ? (
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
    <View>
      {summary ? (
        <Text className="text-muted-foreground text-[13px] mb-2 leading-5" numberOfLines={2}>
          {summary}
        </Text>
      ) : null}
      {(trends || []).slice(0, MAX_TRENDS_DISPLAYED).map((trend: Trend, index: number) => {
        const isLast = index === Math.min(trends.length, MAX_TRENDS_DISPLAYED) - 1;

        return (
          <TouchableOpacity
            key={trend.id}
            className={`flex-row items-center justify-between py-2 ${!isLast ? "border-border" : ""}`}
            style={[
              styles.webCursor,
              !isLast && styles.itemBorder,
            ]}
            onPress={() => handleTrendPress(trend)}
            activeOpacity={0.7}
          >
            <View className="flex-1 flex-row items-center justify-between mr-2">
              <View className="flex-1 mr-3">
                <Text className="text-muted-foreground text-[12px] mb-0.5">
                  {getTrendLabel(trend)}
                </Text>
                <Text className="text-foreground text-[14px] font-bold" numberOfLines={1}>
                  {getTrendDisplayName(trend)}
                </Text>
                {trend.description ? (
                  <Text className="text-muted-foreground text-[12px] mt-0.5" numberOfLines={1}>
                    {trend.description}
                  </Text>
                ) : null}
              </View>
              <View className="items-end">
                <Sparkline direction={trend.direction} color={theme.colors.primary} />
              </View>
            </View>
            <TouchableOpacity
              className="p-1"
              style={styles.webCursor}
              onPress={() => handleMenuPress(trend)}
              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
              accessibilityLabel="More options"
              accessibilityRole="button"
            >
              <Ionicons name="ellipsis-horizontal" size={16} color={theme.colors.textSecondary} />
            </TouchableOpacity>
          </TouchableOpacity>
        );
      })}

      <TouchableOpacity
        className="py-2"
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
      <View className="px-4 pb-2">
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
  itemBorder: { borderBottomWidth: 0.5 },
});
