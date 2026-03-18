import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  SectionList,
  ActivityIndicator,
  SectionListData,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@oxyhq/bloom/theme';
import { Header } from '@/components/Header';
import { ThemedView } from '@/components/ThemedView';
import { trendingService, TrendingTopic, TrendingDay } from '@/services/trendingService';
import { TrendItemRow } from '@/components/trending/TrendItemRow';
import { SPACING } from '@/styles/spacing';
import { FONT_SIZES } from '@/styles/typography';
import type { Trend } from '@/interfaces/Trend';

interface TrendSection {
  title: string;
  data: Trend[];
}

function formatDayLabel(dateStr: string): string {
  const date = new Date(dateStr + 'T00:00:00');
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const target = new Date(date.getFullYear(), date.getMonth(), date.getDate());

  if (target.getTime() === today.getTime()) return 'Today';
  if (target.getTime() === yesterday.getTime()) return 'Yesterday';

  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });
}

function topicToTrend(topic: TrendingTopic): Trend {
  const momentum = topic.momentum || 0;
  let direction: Trend['direction'] = 'flat';
  if (momentum > 0.3) direction = 'up';
  else if (momentum < -0.1) direction = 'down';

  return {
    id: topic.name,
    type: (topic.type || 'hashtag') as Trend['type'],
    text: topic.name,
    hashtag: topic.type === 'hashtag' ? `#${topic.name}` : topic.name,
    description: topic.description || '',
    score: topic.score || 0,
    volume: topic.volume || 0,
    momentum,
    rank: topic.rank || 0,
    created_at: topic.calculatedAt || '',
    direction,
  };
}

export default function TrendingHistoryScreen() {
  const theme = useTheme();
  const router = useRouter();
  const [sections, setSections] = useState<TrendSection[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);

  const fetchHistory = useCallback(async (pageNum: number, append: boolean = false) => {
    try {
      const result = await trendingService.getTrendingHistory(pageNum, 5);
      setTotalPages(result.totalPages);

      const newSections: TrendSection[] = result.days.map((day: TrendingDay) => ({
        title: `${formatDayLabel(day.date)} · ${day.trends.length} trend${day.trends.length !== 1 ? 's' : ''}`,
        data: day.trends.map(topicToTrend),
      }));

      if (append) {
        setSections(prev => [...prev, ...newSections]);
      } else {
        setSections(newSections);
      }
    } catch {
      // Error handled by service
    } finally {
      setIsLoading(false);
      setIsLoadingMore(false);
    }
  }, []);

  useEffect(() => {
    fetchHistory(1);
  }, [fetchHistory]);

  const handleLoadMore = useCallback(() => {
    if (isLoadingMore || page >= totalPages) return;
    setIsLoadingMore(true);
    const nextPage = page + 1;
    setPage(nextPage);
    fetchHistory(nextPage, true);
  }, [isLoadingMore, page, totalPages, fetchHistory]);

  const handleTrendPress = useCallback((trend: Trend) => {
    if (trend.type === 'hashtag') {
      const tag = trend.text.replace(/^#/, '');
      router.push(`/search/%23${encodeURIComponent(tag)}` as any);
    } else {
      router.push(`/search/${encodeURIComponent(trend.text)}` as any);
    }
  }, [router]);

  const renderItem = useCallback(({ item, index }: { item: Trend; index: number }) => (
    <View className="px-4">
      <TrendItemRow
        trend={item}
        onPress={handleTrendPress}
        showBorder
      />
    </View>
  ), [handleTrendPress]);

  const renderSectionHeader = useCallback(({ section }: { section: SectionListData<Trend, TrendSection> }) => (
    <View
      className="px-4 py-2"
      style={{ backgroundColor: theme.colors.backgroundSecondary }}
    >
      <Text
        className="text-muted-foreground font-medium"
        style={{ fontSize: FONT_SIZES.sm }}
      >
        {section.title}
      </Text>
    </View>
  ), [theme]);

  const renderFooter = useCallback(() => {
    if (!isLoadingMore) return null;
    return (
      <View className="items-center py-4">
        <ActivityIndicator size="small" color={theme.colors.primary} />
      </View>
    );
  }, [isLoadingMore, theme]);

  if (isLoading) {
    return (
      <ThemedView className="flex-1">
        <SafeAreaView className="flex-1" edges={['top']}>
          <Header
            options={{ title: 'Trending', headerBackVisible: true }}
          />
          <View className="flex-1 items-center justify-center">
            <ActivityIndicator size="large" color={theme.colors.primary} />
          </View>
        </SafeAreaView>
      </ThemedView>
    );
  }

  return (
    <ThemedView className="flex-1">
      <SafeAreaView className="flex-1" edges={['top']}>
        <Header
          options={{ title: 'Trending', headerBackVisible: true }}
        />
        <SectionList
          sections={sections}
          renderItem={renderItem}
          renderSectionHeader={renderSectionHeader}
          ListFooterComponent={renderFooter}
          keyExtractor={(item, index) => `${item.text}-${index}`}
          onEndReached={handleLoadMore}
          onEndReachedThreshold={0.5}
          stickySectionHeadersEnabled
          ListEmptyComponent={
            <View className="flex-1 items-center justify-center" style={{ paddingVertical: SPACING['3xl'] }}>
              <Ionicons name="trending-up-outline" size={48} color={theme.colors.textSecondary} />
              <Text
                className="text-muted-foreground mt-3"
                style={{ fontSize: FONT_SIZES.md }}
              >
                No trending history yet
              </Text>
            </View>
          }
        />
      </SafeAreaView>
    </ThemedView>
  );
}
