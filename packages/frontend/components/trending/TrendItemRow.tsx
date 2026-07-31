import React, { memo } from 'react';
import { Platform, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useTheme } from '@oxyhq/bloom/theme';
import { formatCompactNumber } from '@/utils/formatNumber';
import type { Trend } from '@/interfaces/Trend';
import { HIT_SLOP_LG } from '@/styles/hitSlop';

/**
 * One trend, shared by every surface that lists them (the right-rail widget,
 * Explore › Trending, the in-feed card).
 *
 * This row used to end in a 50×24 "sparkline" whose geometry was THREE
 * HARDCODED polylines picked by `trend.direction` — invented shape presented as
 * measurement. It is gone, and deliberately not replaced by a flat synthetic
 * line for trends with no series (that would be the same lie, quieter). What is
 * left is honest: an arrow derived directly from `momentum`, the field that
 * already decides `direction`, and nothing at all when a trend is flat.
 *
 * A real sparkline is possible — the `Trending` collection stores a batch every
 * 30 minutes with 90-day retention — but it needs a genuine per-name series and
 * a hard "fewer than 6 real points ⇒ no chart" rule, so it is out of scope here.
 */

/** Arrow shown for a rising or falling trend; a flat trend gets no glyph. */
const DIRECTION_ICON: Record<Trend['direction'], keyof typeof Ionicons.glyphMap | null> = {
  up: 'trending-up',
  down: 'trending-down',
  flat: null,
};

const DIRECTION_ICON_SIZE = 16;

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
  /**
   * 1-based position in the RENDERED list, not `trend.rank`.
   *
   * `rank` is the rank across the whole unfiltered batch, while every surface
   * caps its list and drops the trends the reader hid — so painting `rank` shows
   * gaps (1, 2, 5, 9) as soon as one is hidden. Omitted where a list ordinal
   * would be meaningless.
   */
  ordinal?: number;
}

export const TrendItemRow = memo(function TrendItemRow({
  trend,
  onPress,
  onMenuPress,
  showBorder = false,
  size = 'compact',
  ordinal,
}: TrendItemRowProps) {
  const theme = useTheme();
  const isLarge = size === 'large';
  const directionIcon = DIRECTION_ICON[trend.direction || 'flat'];

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
      {/*
        Top-aligned, not centred: the title may now wrap to two lines, and a
        vertically centred ordinal would float against the middle of the text
        block instead of sitting beside the row it numbers.
      */}
      <View className="flex-1 flex-row items-start justify-between mr-2">
        {ordinal !== undefined ? (
          <Text
            className={`text-muted-foreground mr-2 font-semibold ${isLarge ? 'text-[15px]' : 'text-[13px]'}`}
            style={styles.ordinal}
          >
            {ordinal}
          </Text>
        ) : null}
        <View className="flex-1 mr-3">
          <Text className={`text-muted-foreground ${isLarge ? 'text-[13px]' : 'text-[12px]'} mb-0.5`}>
            {getTrendLabel(trend)}
          </Text>
          {/*
            Wraps to a second line rather than truncating at one: the leading
            ordinal takes horizontal space away from the title, and the widget
            column is the narrowest surface a trend is shown in, so a long
            multi-word name would otherwise be cut mid-word. Two lines is the
            cap — beyond that a runaway name would push the whole list down.
          */}
          <Text
            className={`text-foreground font-bold ${isLarge ? 'text-[16px]' : 'text-[14px]'}`}
            numberOfLines={2}
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
        {directionIcon ? (
          <View className="items-end">
            <Ionicons
              name={directionIcon}
              size={DIRECTION_ICON_SIZE}
              color={theme.colors.textSecondary}
            />
          </View>
        ) : null}
      </View>
      {onMenuPress ? (
        <TouchableOpacity
          className="p-1"
          style={styles.webCursor}
          onPress={() => onMenuPress(trend)}
          hitSlop={HIT_SLOP_LG}
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
  // Tabular figures keep the numerals in a column: without them "10" is wider
  // than "1" and every row below the tenth shifts sideways.
  ordinal: { fontVariant: ['tabular-nums'] },
});
