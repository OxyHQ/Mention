import React, { useCallback } from "react";
import {
  View,
  Text,
  FlatList,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useTheme } from '@oxyhq/bloom/theme';
import type { Trend } from "@/interfaces/Trend";
import { SPACING } from "@/styles/spacing";
import { FONT_SIZES } from "@/styles/typography";

import { TrendItemRow } from "./TrendItemRow";
import { useTrendNavigation } from "@/hooks/useTrendNavigation";

interface TrendingListProps {
  topics: Trend[];
  onRefresh?: () => void;
  refreshing?: boolean;
}

export function TrendingList({ topics, onRefresh, refreshing }: TrendingListProps) {
  const theme = useTheme();

  const { navigateToTrend } = useTrendNavigation();

  const renderItem = useCallback(({ item }: { item: Trend }) => (
    <View className="px-4">
      <TrendItemRow
        trend={item}
        onPress={navigateToTrend}
        showBorder
        size="large"
      />
    </View>
  ), [navigateToTrend]);

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
