import React, { useCallback, useEffect, memo } from 'react';
import { Platform, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Loading } from '@oxyhq/bloom/loading';
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
    // Type assertion needed for dynamic search URLs
    router.push(href as any);
  }, [router]);

  const handleMorePress = useCallback(() => {
    router.push('/explore');
  }, [router]);

  const handleMenuPress = useCallback((trend: Trend) => {
    // Menu actions placeholder
    logger.debug(`Menu pressed for trend: ${trend.hashtag}`);
  }, []);

  // Don't render if there are no trends (and not loading, and no error)
  if (!isLoading && !error && (!trends || trends.length === 0)) {
    return null;
  }

  return (
    <BaseWidget title={t('Trending')}>
      {isLoading ? (
        <View style={styles.centerRow}>
          <Loading size="small" style={{ flex: undefined }} />
          <Text className="text-muted-foreground" style={styles.muted}>Loading trends…</Text>
        </View>
      ) : error ? (
        <Text className="text-destructive" style={styles.error}>{t('error.fetch_trends')}</Text>
      ) : (
        <View style={styles.listContainer}>
          {(trends || []).slice(0, MAX_TRENDS_DISPLAYED).map((trend: Trend, index: number) => {
            const tag = trend.hashtag || trend.text;
            const isLast = index === Math.min(trends.length, MAX_TRENDS_DISPLAYED) - 1;

            return (
              <TouchableOpacity
                key={trend.id}
                className={!isLast ? "border-border" : undefined}
                style={[
                  styles.trendItem,
                  !isLast && { borderBottomWidth: 0.5 },
                ]}
                onPress={() => handleTrendPress(trend)}
                activeOpacity={0.7}
              >
                <View style={styles.trendContent}>
                  <View style={styles.trendTextContainer}>
                    <Text className="text-muted-foreground" style={styles.trendMeta}>
                      Trending · {formatCompactNumber(trend.score)} post{trend.score !== 1 ? 's' : ''}
                    </Text>
                    <Text className="text-foreground" style={styles.trendHashtag} numberOfLines={1}>
                      #{tag?.replace(/^#/, '')}
                    </Text>
                  </View>
                  <View style={styles.trendRight}>
                    <Sparkline direction={trend.direction} color={theme.colors.primary} />
                  </View>
                </View>
                <TouchableOpacity
                  style={styles.menuButton}
                  onPress={() => handleMenuPress(trend)}
                  hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                  accessibilityLabel="More options"
                  accessibilityRole="button"
                >
                  <Ionicons name="ellipsis-horizontal" size={18} color={theme.colors.textSecondary} />
                </TouchableOpacity>
              </TouchableOpacity>
            );
          })}

          <TouchableOpacity
            style={styles.showMore}
            onPress={handleMorePress}
            activeOpacity={0.7}
          >
            <Text className="text-primary" style={styles.showMoreText}>
              Show more
            </Text>
          </TouchableOpacity>
        </View>
      )}
    </BaseWidget>
  );
}

const styles = StyleSheet.create({
  centerRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  muted: { fontSize: 13 },
  error: {},
  listContainer: {
    paddingTop: 4,
  },
  trendItem: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 12,
    position: 'relative',
    ...Platform.select({ web: { cursor: 'pointer' } }),
  },
  trendContent: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginRight: 8,
  },
  trendTextContainer: {
    flex: 1,
    marginRight: 12,
  },
  trendMeta: {
    fontSize: 13,
    marginBottom: 2,
  },
  trendHashtag: {
    fontSize: 15,
    fontWeight: '700',
  },
  trendRight: {
    alignItems: 'flex-end',
  },
  menuButton: {
    padding: 4,
    ...Platform.select({ web: { cursor: 'pointer' } }),
  },
  showMore: {
    paddingTop: 12,
    paddingBottom: 8,
    ...Platform.select({ web: { cursor: 'pointer' } }),
  },
  showMoreText: {
    fontSize: 15,
    fontWeight: '500',
  },
});
