import React, { memo } from 'react';
import { Platform, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import Svg, { Polyline } from 'react-native-svg';
import { useTheme } from '@oxyhq/bloom/theme';
import { formatCompactNumber } from '@/utils/formatNumber';
import type { Trend } from '@/interfaces/Trend';

const SPARKLINE_POINTS = {
  up: '0,20 10,15 20,18 30,12 40,8 50,5',
  down: '0,5 10,8 20,12 30,18 40,15 50,20',
  flat: '0,12 10,13 20,12 30,13 40,12 50,13',
} as const;

const Sparkline = memo(function Sparkline({
  direction,
  color,
}: {
  direction: 'up' | 'down' | 'flat';
  color: string;
}) {
  return (
    <Svg width="50" height="24" viewBox="0 0 50 24">
      <Polyline
        points={SPARKLINE_POINTS[direction]}
        fill="none"
        stroke={color}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
});

function getTrendLabel(trend: Trend): string {
  if (trend.type === 'hashtag' && trend.volume > 0) {
    return `Trending · ${formatCompactNumber(trend.volume)} posts`;
  }
  if (trend.type === 'entity') return 'Trending';
  if (trend.type === 'topic') return 'Trending topic';
  return 'Trending';
}

function getTrendDisplayName(trend: Trend): string {
  if (trend.type === 'hashtag') {
    const tag = trend.hashtag || trend.text;
    return `#${tag?.replace(/^#/, '')}`;
  }
  return trend.text;
}

interface TrendItemRowProps {
  trend: Trend;
  onPress: (trend: Trend) => void;
  onMenuPress?: (trend: Trend) => void;
  showBorder?: boolean;
}

export const TrendItemRow = memo(function TrendItemRow({
  trend,
  onPress,
  onMenuPress,
  showBorder = false,
}: TrendItemRowProps) {
  const theme = useTheme();

  return (
    <TouchableOpacity
      className={`flex-row items-center justify-between py-2 ${showBorder ? "border-border" : ""}`}
      style={[
        styles.webCursor,
        showBorder && styles.itemBorder,
      ]}
      onPress={() => onPress(trend)}
      activeOpacity={0.7}
    >
      <View className="flex-1 flex-row items-center justify-between mr-2">
        <View className="flex-1 mr-3">
          <Text className="text-muted-foreground text-[12px] mb-0.5">
            {getTrendLabel(trend)}
          </Text>
          <Text className="text-foreground text-[14px] font-bold" numberOfLines={1}>
            {getTrendDisplayName(trend)}
          </Text>
          {trend.description ? (
            <Text className="text-muted-foreground text-[12px] mt-0.5" numberOfLines={1}>
              {trend.description}
            </Text>
          ) : null}
        </View>
        <View className="items-end">
          <Sparkline direction={trend.direction || 'flat'} color={theme.colors.primary} />
        </View>
      </View>
      {onMenuPress ? (
        <TouchableOpacity
          className="p-1"
          style={styles.webCursor}
          onPress={() => onMenuPress(trend)}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          accessibilityLabel="More options"
          accessibilityRole="button"
        >
          <Ionicons name="ellipsis-horizontal" size={16} color={theme.colors.textSecondary} />
        </TouchableOpacity>
      ) : null}
    </TouchableOpacity>
  );
});

const styles = StyleSheet.create({
  webCursor: Platform.select({ web: { cursor: 'pointer' }, default: {} }),
  itemBorder: { borderBottomWidth: 0.5 },
});
