import React, { useEffect } from 'react';
import { ActivityIndicator, Platform, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { useRouter } from 'expo-router';
import { colors } from '@/styles/colors';
import { BaseWidget } from './BaseWidget';
import { useTrendsStore } from '@/store/trendsStore';

export function TrendsWidget() {
  const { t } = useTranslation();
  const { trends, isLoading, error, fetchTrends } = useTrendsStore();
  const router = useRouter();

  useEffect(() => {
    fetchTrends();
    const id = setInterval(() => fetchTrends({ silent: true }), 60000);
    return () => clearInterval(id);
  }, [fetchTrends]);

  const handleTrendPress = (trend: any) => {
    const tag = trend.hashtag || trend.text;
    const href = `/search/%23${encodeURIComponent(tag?.replace(/^#/, ''))}`;
    router.push(href);
  };

  return (
    <BaseWidget title={t('Trends for you')}>
      {isLoading ? (
        <View style={styles.centerRow}>
          <ActivityIndicator size="small" color={colors.primaryColor} />
          <Text style={styles.muted}>Loading trends…</Text>
        </View>
      ) : error ? (
        <Text style={styles.error}>{t('error.fetch_trends')}</Text>
      ) : (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.chipsContainer}
        >
          {(trends || []).slice(0, 8).map((trend: any) => {
            const tag = trend.hashtag || trend.text;
            const dir = trend.direction || 'flat';
            const iconName = dir === 'up' ? 'trending-up-outline' : dir === 'down' ? 'trending-down-outline' : 'remove-outline';
            const iconColor = dir === 'up' ? colors.online : dir === 'down' ? colors.busy : colors.COLOR_BLACK_LIGHT_4;

            return (
              <TouchableOpacity
                key={trend.id}
                style={styles.chip}
                onPress={() => handleTrendPress(trend)}
                activeOpacity={0.7}
              >
                <View style={styles.chipContent}>
                  <Text style={styles.chipText}>#{tag?.replace(/^#/, '')}</Text>
                  <View style={styles.chipStats}>
                    <Text style={styles.chipCount}>{trend.score}</Text>
                    <Ionicons name={iconName as any} size={14} color={iconColor} />
                  </View>
                </View>
              </TouchableOpacity>
            );
          })}
        </ScrollView>
      )}
    </BaseWidget>
  );
}

const styles = StyleSheet.create({
  centerRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  muted: { color: colors.COLOR_BLACK_LIGHT_4, fontSize: 13 },
  error: { color: 'red' },
  chipsContainer: {
    paddingTop: 10,
    paddingBottom: 5,
    gap: 8,
    flexDirection: 'row',
  },
  chip: {
    backgroundColor: colors.primaryLight_1,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: colors.primaryColor,
    paddingHorizontal: 12,
    paddingVertical: 8,
    minWidth: 80,
    maxWidth: 140,
    ...Platform.select({ web: { cursor: 'pointer' } }),
  },
  chipContent: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 6,
  },
  chipText: {
    fontWeight: '600',
    fontSize: 14,
    color: colors.primaryColor,
    flex: 1,
  },
  chipStats: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
  },
  chipCount: {
    fontSize: 12,
    color: colors.COLOR_BLACK_LIGHT_4,
    fontWeight: '500',
  },
});
