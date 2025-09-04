import React, { useEffect } from 'react';
import { ActivityIndicator, Platform, StyleSheet, Text, View } from 'react-native';
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
        <View style={{ gap: 10, paddingTop: 10 }}>
          {(trends || []).slice(0, 5).map((trend: any, idx: number, arr: any[]) => {
            const tag = trend.hashtag || trend.text;
            const href = `/search/%23${encodeURIComponent(tag?.replace(/^#/, ''))}`;
            const isLast = idx === arr.length - 1;
            const dir = trend.direction || 'flat';
            const iconName = dir === 'up' ? 'trending-up-outline' : dir === 'down' ? 'trending-down-outline' : 'remove-outline';
            const iconColor = dir === 'up' ? colors.online : dir === 'down' ? colors.busy : colors.COLOR_BLACK_LIGHT_4;
            return (
              <View key={trend.id}>
                <View
                  style={[styles.row, isLast && styles.rowLast]}
                >
                  <View style={styles.rowTextWrap}>
                    <Text style={styles.title} onPress={() => router.push(href)}>#{tag?.replace(/^#/, '')}</Text>
                    <Text style={styles.subtitle}>{trend.score} posts</Text>
                  </View>
                  <Ionicons name={iconName as any} size={22} color={iconColor} />
                </View>
              </View>
            );
          })}
        </View>
      )}
    </BaseWidget>
  );
}

const styles = StyleSheet.create({
  centerRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  muted: { color: colors.COLOR_BLACK_LIGHT_4, fontSize: 13 },
  error: { color: 'red' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: 0.01,
    borderBottomColor: colors.COLOR_BLACK_LIGHT_6,
    ...Platform.select({ web: { cursor: 'pointer' } }),
    paddingBottom: 10,
  },
  rowLast: {
    borderBottomWidth: 0,
  },
  rowTextWrap: { flex: 1 },
  title: { fontWeight: 'bold', fontSize: 15, color: colors.COLOR_BLACK_LIGHT_1 },
  subtitle: { color: colors.COLOR_BLACK_LIGHT_4, paddingTop: 4, fontSize: 13 },
});
