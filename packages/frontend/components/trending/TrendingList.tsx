import React, { useCallback } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  FlatList,
  ListRenderItem,
} from "react-native";
import { router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useTheme } from '@oxyhq/bloom/theme';
import { TrendingTopic } from "@/services/trendingService";
import { SPACING } from "@/styles/spacing";
import { FONT_SIZES } from "@/styles/typography";
import { Divider } from "@oxyhq/bloom/divider";
import { formatCompactNumber } from "@/utils/formatNumber";

interface TrendingListProps {
  topics: TrendingTopic[];
  onRefresh?: () => void;
  refreshing?: boolean;
}

export function TrendingList({ topics, onRefresh, refreshing }: TrendingListProps) {
  const theme = useTheme();

  const handleTopicPress = useCallback((topic: TrendingTopic) => {
    if (topic.type === 'hashtag') {
      const cleanedName = topic.name.replace(/^#/, '');
      router.push(`/search/%23${encodeURIComponent(cleanedName)}`);
    } else {
      router.push(`/search/${encodeURIComponent(topic.name)}`);
    }
  }, []);

  const formatVolume = useCallback((volume: number): string => {
    return `${formatCompactNumber(volume)} posts`;
  }, []);

  const getMomentumIcon = useCallback((momentum: number): string => {
    if (momentum > 0.1) return "trending-up";
    if (momentum < -0.1) return "trending-down";
    return "remove";
  }, []);

  const getMomentumColor = useCallback((momentum: number): string => {
    if (momentum > 0.1) return "#10b981";
    if (momentum < -0.1) return "#ef4444";
    return theme.colors.textSecondary;
  }, [theme.colors.textSecondary]);

  const getTypeLabel = useCallback((topic: TrendingTopic): string => {
    if (topic.type === 'entity') return 'Trending';
    if (topic.type === 'topic') return 'Trending topic';
    return 'Trending';
  }, []);

  const getDisplayName = useCallback((topic: TrendingTopic): string => {
    if (topic.type === 'hashtag') {
      return topic.name.startsWith('#') ? topic.name : `#${topic.name}`;
    }
    return topic.name;
  }, []);

  const renderTrendingItem: ListRenderItem<TrendingTopic> = useCallback(({ item }) => {
    const displayName = getDisplayName(item);
    const momentumIcon = getMomentumIcon(item.momentum);
    const momentumColor = getMomentumColor(item.momentum);
    const typeLabel = getTypeLabel(item);

    return (
      <View>
        <TouchableOpacity
          className="flex-row items-center px-4 py-3"
          style={{ gap: SPACING.md }}
          onPress={() => handleTopicPress(item)}
          activeOpacity={0.7}
        >
          <View className="items-center" style={{ width: 32 }}>
            <Text className="text-muted-foreground font-bold" style={{ fontSize: FONT_SIZES.lg }}>
              {item.rank}
            </Text>
          </View>

          <View className="flex-1">
            <View className="flex-row items-center justify-between" style={{ marginBottom: SPACING.xs }}>
              <Text
                className="text-foreground font-semibold flex-1"
                style={{ fontSize: FONT_SIZES.lg, marginRight: SPACING.sm }}
                numberOfLines={1}
              >
                {displayName}
              </Text>
              <Ionicons
                name={momentumIcon}
                size={20}
                color={momentumColor}
              />
            </View>

            {item.description ? (
              <Text
                className="text-muted-foreground"
                style={{ fontSize: FONT_SIZES.sm, marginBottom: SPACING.xs }}
                numberOfLines={2}
              >
                {item.description}
              </Text>
            ) : null}

            <Text className="text-muted-foreground" style={{ fontSize: FONT_SIZES.xs }}>
              {item.type === 'hashtag' && item.volume > 0
                ? formatVolume(item.volume)
                : typeLabel}
            </Text>
          </View>

          <Ionicons
            name="chevron-forward"
            size={16}
            color={theme.colors.textTertiary}
          />
        </TouchableOpacity>
        <Divider />
      </View>
    );
  }, [theme, handleTopicPress, formatVolume, getMomentumIcon, getMomentumColor, getDisplayName, getTypeLabel]);

  const keyExtractor = useCallback((item: TrendingTopic) => {
    return `${item.rank}-${item.name}`;
  }, []);

  if (topics.length === 0) {
    return (
      <View className="flex-1 items-center justify-center" style={{ paddingVertical: SPACING['3xl'], gap: SPACING.md }}>
        <Ionicons
          name="trending-up-outline"
          size={48}
          color={theme.colors.textSecondary}
        />
        <Text className="text-muted-foreground" style={{ fontSize: FONT_SIZES.md }}>
          No trending topics available
        </Text>
      </View>
    );
  }

  return (
    <FlatList
      data={topics}
      renderItem={renderTrendingItem}
      keyExtractor={keyExtractor}
      onRefresh={onRefresh}
      refreshing={refreshing}
      contentContainerStyle={{ paddingBottom: SPACING.base }}
      showsVerticalScrollIndicator={true}
    />
  );
}
