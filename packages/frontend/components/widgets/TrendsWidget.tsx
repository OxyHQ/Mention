import React, { useEffect } from 'react';
import { ActivityIndicator, Platform, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useRouter } from 'expo-router';
import { colors } from '@/styles/colors';
import { BaseWidget } from './BaseWidget';
import { useTrendsStore } from '@/store/trendsStore';
import { useTheme } from '@/hooks/useTheme';

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

  const handleTrendPress = (trend: any) => {
    const tag = trend.hashtag || trend.text;
    const href = `/search/%23${encodeURIComponent(tag?.replace(/^#/, ''))}`;
    router.push(href);
  };

  return (
    <BaseWidget title={t('Trending')}>
      {isLoading ? (
        <View style={styles.centerRow}>
          <ActivityIndicator size="small" color={theme.colors.primary} />
          <Text style={[styles.muted, { color: theme.colors.textSecondary }]}>Loading trends…</Text>
        </View>
      ) : error ? (
        <Text style={[styles.error, { color: theme.colors.error }]}>{t('error.fetch_trends')}</Text>
      ) : (
        <View style={styles.chipsWrap}>
          {(trends || []).slice(0, 10).map((trend: any) => {
            const tag = trend.hashtag || trend.text;
            return (
              <TouchableOpacity
                key={trend.id}
                style={[styles.chip, { borderColor: theme.colors.text }]}
                onPress={() => handleTrendPress(trend)}
                activeOpacity={0.8}
              >
                <Text style={[styles.chipText, { color: theme.colors.text }]}>#{tag?.replace(/^#/, '')}</Text>
              </TouchableOpacity>
            );
          })}
        </View>
      )}
    </BaseWidget>
  );
}

const styles = StyleSheet.create({
  centerRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  muted: { color: "#71767B", fontSize: 13 },
  error: { color: "#F91880" },
  chipsWrap: {
    paddingTop: 4,
    paddingBottom: 1,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 4,
    alignItems: 'flex-start',
  },
  chip: {
    backgroundColor: 'transparent',
    borderRadius: 20,
    borderWidth: 1,
    borderColor: "#0F1419",
    paddingHorizontal: 10,
    paddingVertical: 4,
    marginRight: 4,
    ...Platform.select({ web: { cursor: 'pointer' } }),
  },
  chipText: {
    fontWeight: '600',
    fontSize: 13,
    color: "#0F1419",
  },
});
