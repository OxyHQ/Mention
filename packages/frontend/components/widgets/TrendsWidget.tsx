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

export function TrendsWidget() {
  const { t } = useTranslation();
  const { trends, isLoading, error, fetchTrends } = useTrendsStore();
  const router = useRouter();
  const theme = useTheme();

  useEffect(() => {
    fetchTrends();
    const id = setInterval(() => fetchTrends({ silent: true }), 60000);
    return () => clearInterval(id);
  }, [fetchTrends]);

  const handleTrendPress = useCallback((trend: Trend) => {
    const tag = trend.hashtag || trend.text;
    const href = `/search/%23${encodeURIComponent(tag?.replace(/^#/, ''))}`;
    router.push(href as any);
  }, [router]);

  const handleMorePress = useCallback(() => {
    router.push('/explore');
  }, [router]);

  const handleMenuPress = useCallback((trend: Trend) => {
    logger.debug(`Menu pressed for trend: ${trend.hashtag}`);
  }, []);

  if (!isLoading && !error && (!trends || trends.length === 0)) {
    return null;
  }

  return (
    <BaseWidget title={t('Trending')}>
      {isLoading ? (
        <View className="pt-1 gap-3">
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
        <View className="pt-1">
          {(trends || []).slice(0, MAX_TRENDS_DISPLAYED).map((trend: Trend, index: number) => {
            const tag = trend.hashtag || trend.text;
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
                      Trending · {formatCompactNumber(trend.score)} post{trend.score !== 1 ? 's' : ''}
                    </Text>
                    <Text className="text-foreground text-[14px] font-bold" numberOfLines={1}>
                      #{tag?.replace(/^#/, '')}
                    </Text>
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
            className="pt-2 pb-1"
            style={styles.webCursor}
            onPress={handleMorePress}
            activeOpacity={0.7}
          >
            <Text className="text-primary text-[14px] font-medium">
              Show more
            </Text>
          </TouchableOpacity>
        </View>
      )}
    </BaseWidget>
  );
}

const styles = StyleSheet.create({
  webCursor: Platform.select({ web: { cursor: 'pointer' }, default: {} }),
  itemBorder: { borderBottomWidth: 0.5 },
});
