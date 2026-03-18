import React, { useCallback } from "react";
import {
  View,
  Text,
  FlatList,
} from "react-native";
import { router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useTheme } from '@oxyhq/bloom/theme';
import type { Trend } from "@/interfaces/Trend";
import { SPACING } from "@/styles/spacing";
import { FONT_SIZES } from "@/styles/typography";
import { Divider } from "@oxyhq/bloom/divider";
import { TrendItemRow } from "./TrendItemRow";

interface TrendingListProps {
  topics: Trend[];
  onRefresh?: () => void;
  refreshing?: boolean;
}

export function TrendingList({ topics, onRefresh, refreshing }: TrendingListProps) {
  const theme = useTheme();

  const handleTopicPress = useCallback((trend: Trend) => {
    if (trend.type === 'hashtag') {
      const cleanedName = trend.text.replace(/^#/, '');
      router.push(`/search/%23${encodeURIComponent(cleanedName)}`);
    } else {
      router.push(`/search/${encodeURIComponent(trend.text)}`);
    }
  }, []);

  const renderItem = useCallback(({ item }: { item: Trend }) => (
    <View className="px-4">
      <TrendItemRow
        trend={item}
        onPress={handleTopicPress}
        showBorder
        size="large"
      />
    </View>
  ), [handleTopicPress]);

  const keyExtractor = useCallback((item: Trend) => {
    return `${item.rank}-${item.text}`;
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
      renderItem={renderItem}
      keyExtractor={keyExtractor}
      onRefresh={onRefresh}
      refreshing={refreshing}
      contentContainerStyle={{ paddingBottom: SPACING.base }}
      showsVerticalScrollIndicator={true}
    />
  );
}
