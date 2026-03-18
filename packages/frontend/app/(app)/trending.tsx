import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
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
import { Divider } from '@oxyhq/bloom/divider';
import { trendingService, TrendingTopic, TrendingBatch } from '@/services/trendingService';
import { SPACING } from '@/styles/spacing';
import { FONT_SIZES } from '@/styles/typography';

interface TrendSection {
  title: string;
  data: TrendingTopic[];
}

function formatBatchDate(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const time = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

  const isToday = date.toDateString() === now.toDateString();
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const isYesterday = date.toDateString() === yesterday.toDateString();

  if (isToday) return `Today at ${time}`;
  if (isYesterday) return `Yesterday at ${time}`;

  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  }) + ` at ${time}`;
}

function getBatchFingerprint(trends: TrendingTopic[]): string {
  return trends.map(t => t.name).sort().join('|');
}

function deduplicateBatches(batches: TrendingBatch[]): TrendSection[] {
  const sections: TrendSection[] = [];
  let skipCount = 0;

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    const fingerprint = getBatchFingerprint(batch.trends);

    // Check how many subsequent batches have the same content
    let duplicateCount = 0;
    for (let j = i + 1; j < batches.length; j++) {
      if (getBatchFingerprint(batches[j].trends) === fingerprint) {
        duplicateCount++;
      } else {
        break;
      }
    }

    const trendCount = batch.trends.length;
    let title = `${formatBatchDate(batch.calculatedAt)} · ${trendCount} trend${trendCount !== 1 ? 's' : ''}`;

    if (duplicateCount > 0) {
      title += ` (${duplicateCount + 1} identical batches)`;
      i += duplicateCount; // skip the duplicates
    }

    sections.push({ title, data: batch.trends });
  }

  return sections;
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

      const newSections = deduplicateBatches(result.batches);

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

  const handleTopicPress = useCallback((topic: TrendingTopic) => {
    if (topic.type === 'hashtag') {
      const cleanedName = topic.name.replace(/^#/, '');
      router.push(`/search/%23${encodeURIComponent(cleanedName)}` as any);
    } else {
      router.push(`/search/${encodeURIComponent(topic.name)}` as any);
    }
  }, [router]);

  const getDisplayName = useCallback((topic: TrendingTopic): string => {
    if (topic.type === 'hashtag') {
      return topic.name.startsWith('#') ? topic.name : `#${topic.name}`;
    }
    return topic.name;
  }, []);

  const getTypeIcon = useCallback((type: string): string => {
    if (type === 'entity') return 'person-outline';
    if (type === 'topic') return 'chatbubble-outline';
    return 'pricetag-outline';
  }, []);

  const renderItem = useCallback(({ item }: { item: TrendingTopic }) => (
    <TouchableOpacity
      className="flex-row items-center px-4 py-3"
      style={{ gap: SPACING.md }}
      onPress={() => handleTopicPress(item)}
      activeOpacity={0.7}
    >
      <View
        className="items-center justify-center rounded-full"
        style={{
          width: 36,
          height: 36,
          backgroundColor: theme.colors.backgroundSecondary,
        }}
      >
        <Ionicons
          name={getTypeIcon(item.type)}
          size={18}
          color={theme.colors.textSecondary}
        />
      </View>

      <View className="flex-1">
        <Text
          className="text-foreground font-semibold"
          style={{ fontSize: FONT_SIZES.md }}
          numberOfLines={1}
        >
          {getDisplayName(item)}
        </Text>
        {item.description ? (
          <Text
            className="text-muted-foreground"
            style={{ fontSize: FONT_SIZES.sm, marginTop: 2 }}
            numberOfLines={2}
          >
            {item.description}
          </Text>
        ) : null}
      </View>

      <Ionicons name="chevron-forward" size={16} color={theme.colors.textTertiary} />
    </TouchableOpacity>
  ), [theme, handleTopicPress, getDisplayName, getTypeIcon]);

  const renderSectionHeader = useCallback(({ section }: { section: SectionListData<TrendingTopic, TrendSection> }) => (
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

  const renderSeparator = useCallback(() => <Divider />, []);

  if (isLoading) {
    return (
      <ThemedView className="flex-1">
        <SafeAreaView className="flex-1" edges={['top']}>
          <Header
            options={{ title: 'Trending History', headerBackVisible: true }}
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
          options={{ title: 'Trending History', headerBackVisible: true }}
        />
        <SectionList
          sections={sections}
          renderItem={renderItem}
          renderSectionHeader={renderSectionHeader}
          ItemSeparatorComponent={renderSeparator}
          ListFooterComponent={renderFooter}
          keyExtractor={(item, index) => `${item.name}-${index}`}
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
