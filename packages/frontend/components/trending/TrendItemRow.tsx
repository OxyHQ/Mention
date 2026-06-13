import React, { memo, useId, useMemo } from 'react';
import { Platform, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import Svg, { Defs, LinearGradient, Polygon, Polyline, Stop } from 'react-native-svg';
import { useTheme } from '@oxyhq/bloom/theme';
import { formatCompactNumber } from '@/utils/formatNumber';
import type { Trend } from '@/interfaces/Trend';

const SPARKLINE_WIDTH = 50;
const SPARKLINE_HEIGHT = 24;
const SPARKLINE_BASELINE_Y = SPARKLINE_HEIGHT;
const SPARKLINE_AREA_TOP_OPACITY = 0.28;
const SPARKLINE_AREA_BOTTOM_OPACITY = 0;

type Point = readonly [number, number];

const SPARKLINE_POINTS: Record<'up' | 'down' | 'flat', readonly Point[]> = {
  up: [[0, 20], [10, 15], [20, 18], [30, 12], [40, 8], [50, 5]],
  down: [[0, 5], [10, 8], [20, 12], [30, 18], [40, 15], [50, 20]],
  flat: [[0, 12], [10, 13], [20, 12], [30, 13], [40, 12], [50, 13]],
};

function toPolylinePoints(points: readonly Point[]): string {
  return points.map(([x, y]) => `${x},${y}`).join(' ');
}

function toAreaPoints(points: readonly Point[]): string {
  if (points.length < 2) return '';
  const first = points[0];
  const last = points[points.length - 1];
  // Close the path: follow the line, drop to the baseline at the last x,
  // then back to the baseline at the first x.
  return [
    ...points.map(([x, y]) => `${x},${y}`),
    `${last[0]},${SPARKLINE_BASELINE_Y}`,
    `${first[0]},${SPARKLINE_BASELINE_Y}`,
  ].join(' ');
}

const Sparkline = memo(function Sparkline({
  direction,
  color,
}: {
  direction: 'up' | 'down' | 'flat';
  color: string;
}) {
  const gradientId = useId();
  const points = SPARKLINE_POINTS[direction];

  const linePoints = useMemo(() => toPolylinePoints(points), [points]);
  const areaPoints = useMemo(() => toAreaPoints(points), [points]);
  const hasArea = areaPoints.length > 0;

  return (
    <Svg
      width={SPARKLINE_WIDTH}
      height={SPARKLINE_HEIGHT}
      viewBox={`0 0 ${SPARKLINE_WIDTH} ${SPARKLINE_HEIGHT}`}
    >
      {hasArea ? (
        <Defs>
          <LinearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={color} stopOpacity={SPARKLINE_AREA_TOP_OPACITY} />
            <Stop offset="1" stopColor={color} stopOpacity={SPARKLINE_AREA_BOTTOM_OPACITY} />
          </LinearGradient>
        </Defs>
      ) : null}
      {hasArea ? (
        <Polygon points={areaPoints} fill={`url(#${gradientId})`} stroke="none" />
      ) : null}
      <Polyline
        points={linePoints}
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
  size?: 'compact' | 'large';
}

export const TrendItemRow = memo(function TrendItemRow({
  trend,
  onPress,
  onMenuPress,
  showBorder = false,
  size = 'compact',
}: TrendItemRowProps) {
  const theme = useTheme();
  const isLarge = size === 'large';

  return (
    <TouchableOpacity
      className={`flex-row items-center justify-between ${isLarge ? 'py-3' : 'py-1.5'} ${showBorder ? "border-border" : ""}`}
      style={[
        styles.webCursor,
        showBorder && styles.itemBorder,
      ]}
      onPress={() => onPress(trend)}
      activeOpacity={0.7}
    >
      <View className="flex-1 flex-row items-center justify-between mr-2">
        <View className="flex-1 mr-3">
          <Text className={`text-muted-foreground ${isLarge ? 'text-[13px]' : 'text-[12px]'} mb-0.5`}>
            {getTrendLabel(trend)}
          </Text>
          <Text
            className={`text-foreground font-bold ${isLarge ? 'text-[16px]' : 'text-[14px]'}`}
            numberOfLines={1}
          >
            {getTrendDisplayName(trend)}
          </Text>
          {trend.description ? (
            <Text
              className={`text-muted-foreground ${isLarge ? 'text-[13px] mt-1' : 'text-[12px] mt-0.5'}`}
              numberOfLines={isLarge ? 2 : 1}
            >
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
