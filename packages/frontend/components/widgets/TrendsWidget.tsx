import React, { useCallback, useEffect } from 'react';
import { Platform, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import * as Skeleton from '@oxyhq/bloom/skeleton';
import { useTranslation } from 'react-i18next';
import { useRouter } from 'expo-router';
import { BaseWidget } from './BaseWidget';
import { useTrendsStore } from '@/store/trendsStore';
import type { Trend } from '@/interfaces/Trend';
import { useTrendNavigation } from '@/hooks/useTrendNavigation';
import { logger } from '@/lib/logger';
import { TrendItemRow } from '@/components/trending/TrendItemRow';

const MAX_TRENDS_DISPLAYED = 5;

interface TrendsWidgetProps {
  variant?: 'card' | 'inline';
}

export function TrendsWidget({ variant = 'card' }: TrendsWidgetProps) {
  const { t } = useTranslation();
  const { trends, summary, isLoading, error, startPolling } = useTrendsStore();
  const router = useRouter();

  useEffect(() => {
    startPolling();
  }, [startPolling]);

  const { navigateToTrend } = useTrendNavigation();

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
          <TrendItemRow
            key={trend.id}
            trend={trend}
            onPress={navigateToTrend}
            onMenuPress={handleMenuPress}
            showBorder={!isLast}
          />
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
});
