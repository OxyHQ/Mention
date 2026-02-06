import React, { useCallback } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  FlatList,
  ListRenderItem,
} from "react-native";
import { router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useTheme } from "@/hooks/useTheme";
import { TrendingTopic } from "@/services/trendingService";
import { SPACING } from "@/styles/spacing";
import { FONT_SIZES } from "@/styles/typography";
import { Divider } from "@/components/Divider";

interface TrendingListProps {
  topics: TrendingTopic[];
  onRefresh?: () => void;
  refreshing?: boolean;
}

export function TrendingList({ topics, onRefresh, refreshing }: TrendingListProps) {
  const theme = useTheme();

  const handleTopicPress = useCallback((topicName: string) => {
    const cleanedName = topicName.replace(/^#/, '');
    router.push(`/hashtag/${cleanedName}`);
  }, []);

  const formatVolume = useCallback((volume: number): string => {
    if (volume >= 1000000) {
      return `${(volume / 1000000).toFixed(1)}M posts`;
    }
    if (volume >= 1000) {
      return `${(volume / 1000).toFixed(1)}K posts`;
    }
    return `${volume} posts`;
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

  const renderTrendingItem: ListRenderItem<TrendingTopic> = useCallback(({ item }) => {
    const displayName = item.name.startsWith('#') ? item.name : `#${item.name}`;
    const momentumIcon = getMomentumIcon(item.momentum);
    const momentumColor = getMomentumColor(item.momentum);

    return (
      <View>
        <TouchableOpacity
          style={styles.item}
          onPress={() => handleTopicPress(item.name)}
          activeOpacity={0.7}
        >
          <View style={styles.rankContainer}>
            <Text style={[styles.rankText, { color: theme.colors.textSecondary }]}>
              {item.rank}
            </Text>
          </View>

          <View style={styles.content}>
            <View style={styles.topRow}>
              <Text
                style={[styles.topicName, { color: theme.colors.text }]}
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

            <Text style={[styles.volume, { color: theme.colors.textSecondary }]}>
              {formatVolume(item.volume)}
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
  }, [theme, handleTopicPress, formatVolume, getMomentumIcon, getMomentumColor]);

  const keyExtractor = useCallback((item: TrendingTopic) => {
    return `${item.rank}-${item.name}`;
  }, []);

  if (topics.length === 0) {
    return (
      <View style={styles.emptyContainer}>
        <Ionicons
          name="trending-up-outline"
          size={48}
          color={theme.colors.textSecondary}
        />
        <Text style={[styles.emptyText, { color: theme.colors.textSecondary }]}>
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
      contentContainerStyle={styles.listContent}
      showsVerticalScrollIndicator={true}
    />
  );
}

const styles = StyleSheet.create({
  listContent: {
    paddingBottom: SPACING.base,
  },
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: SPACING.base,
    paddingVertical: SPACING.md,
    gap: SPACING.md,
  },
  rankContainer: {
    width: 32,
    alignItems: 'center',
  },
  rankText: {
    fontSize: FONT_SIZES.lg,
    fontWeight: '700',
  },
  content: {
    flex: 1,
  },
  topRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: SPACING.xs,
  },
  topicName: {
    fontSize: FONT_SIZES.lg,
    fontWeight: '600',
    flex: 1,
    marginRight: SPACING.sm,
  },
  volume: {
    fontSize: FONT_SIZES.sm,
  },
  emptyContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: SPACING['3xl'],
    gap: SPACING.md,
  },
  emptyText: {
    fontSize: FONT_SIZES.md,
  },
});
