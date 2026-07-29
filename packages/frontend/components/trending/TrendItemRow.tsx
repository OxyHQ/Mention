import React, { memo, useId, useMemo } from 'react';
import { Platform, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import Svg, { Defs, LinearGradient, Polygon, Polyline, Stop } from 'react-native-svg';
import { useTheme } from '@oxyhq/bloom/theme';
import { formatCompactNumber } from '@/utils/formatNumber';
import type { Trend } from '@/interfaces/Trend';

/**
 * One trend, shared by every surface that lists them (the right-rail widget,
 * Explore › Trending, the in-feed card).
 *
 * The row ends in a volume sparkline drawn from `trend.series` — the real
 * history of this trend's `volume` across the stored trending batches. An
 * earlier version of this chart had THREE HARDCODED polylines picked by
 * `trend.direction`, so every rising trend drew the same curve whatever its
 * numbers; that was invented shape presented as measurement and it was deleted.
 *
 * The rules that keep the replacement honest:
 *
 *  - Geometry comes from the series and nothing else. There is no fallback
 *    shape, no interpolation and no padding of a short series.
 *  - No series ⇒ NO CHART. The server omits `series` for a trend it has watched
 *    across too few batches to draw (the floor is
 *    `MtnConfig.trending.series.minPoints`, applied server-side so there is one
 *    authority for it). Those rows fall back to the direction arrow, which is a
 *    single honest bit derived from `momentum` — never a flat placeholder line.
 *  - A genuinely FLAT series still draws, as a flat line. That is the
 *    measurement, not a stand-in for missing data, and suppressing it would make
 *    the chart's presence a hidden signal a reader cannot interpret.
 *
 * The arrow and the chart are alternatives, never both: they answer the same
 * question at different resolutions, and the widget column — the narrowest
 * surface a trend appears in, now also carrying a leading ordinal — has no
 * horizontal budget to spend saying it twice.
 */

/** Arrow shown for a rising or falling trend; a flat trend gets no glyph. */
const DIRECTION_ICON: Record<Trend['direction'], keyof typeof Ionicons.glyphMap | null> = {
  up: 'trending-up',
  down: 'trending-down',
  flat: null,
};

const DIRECTION_ICON_SIZE = 16;

const SPARKLINE_WIDTH = 50;
const SPARKLINE_HEIGHT = 24;
const SPARKLINE_BASELINE_Y = SPARKLINE_HEIGHT;
/**
 * Vertical breathing room, in SVG units, kept above the highest point and below
 * the lowest. The stroke is 2 wide with round caps, so without it an extreme
 * point is shaved by the viewBox edge.
 */
const SPARKLINE_VERTICAL_INSET = 4;
const SPARKLINE_STROKE_WIDTH = 2;
const SPARKLINE_AREA_TOP_OPACITY = 0.28;
const SPARKLINE_AREA_BOTTOM_OPACITY = 0;
/**
 * Two points make a line — a STRUCTURAL requirement of `Polyline`, not a
 * coverage policy. How much history is enough to be worth drawing is decided by
 * the server, which simply omits `series` below its floor; this guard only keeps
 * the component total if a single point ever reaches it.
 */
const MIN_POLYLINE_POINTS = 2;

/**
 * Map a series to `viewBox` coordinates: x spreads the points evenly across the
 * full width, y scales the value range into the inset band, inverted so a larger
 * volume sits higher.
 *
 * A CONSTANT series (max === min) has no range to scale into and would otherwise
 * divide by zero. It is drawn at the vertical middle — the one placement that
 * does not imply the volume was high or low, only that it did not move. This is
 * a common shape, not an edge case: `volume` is a trailing 24-hour post count, so
 * on a quiet instance a trend genuinely holds the same number for hours.
 */
function toSparklinePoints(series: readonly number[]): readonly (readonly [number, number])[] {
  const max = Math.max(...series);
  const min = Math.min(...series);
  const span = max - min;
  const usableHeight = SPARKLINE_HEIGHT - SPARKLINE_VERTICAL_INSET * 2;

  return series.map((value, index) => {
    const x = (index / (series.length - 1)) * SPARKLINE_WIDTH;
    const fraction = span === 0 ? 0.5 : (value - min) / span;
    return [x, SPARKLINE_HEIGHT - SPARKLINE_VERTICAL_INSET - fraction * usableHeight] as const;
  });
}

function toPolylinePoints(points: readonly (readonly [number, number])[]): string {
  return points.map(([x, y]) => `${x},${y}`).join(' ');
}

/**
 * Close the line into a fillable area: follow it, drop to the baseline under the
 * last point, then run back along the baseline to the first.
 */
function toAreaPoints(points: readonly (readonly [number, number])[]): string {
  const first = points[0];
  const last = points[points.length - 1];
  return [
    ...points.map(([x, y]) => `${x},${y}`),
    `${last[0]},${SPARKLINE_BASELINE_Y}`,
    `${first[0]},${SPARKLINE_BASELINE_Y}`,
  ].join(' ');
}

const Sparkline = memo(function Sparkline({
  series,
  color,
}: {
  series: number[];
  color: string;
}) {
  const gradientId = useId();
  const points = useMemo(() => toSparklinePoints(series), [series]);
  const linePoints = useMemo(() => toPolylinePoints(points), [points]);
  const areaPoints = useMemo(() => toAreaPoints(points), [points]);

  return (
    <Svg
      width={SPARKLINE_WIDTH}
      height={SPARKLINE_HEIGHT}
      viewBox={`0 0 ${SPARKLINE_WIDTH} ${SPARKLINE_HEIGHT}`}
    >
      <Defs>
        <LinearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor={color} stopOpacity={SPARKLINE_AREA_TOP_OPACITY} />
          <Stop offset="1" stopColor={color} stopOpacity={SPARKLINE_AREA_BOTTOM_OPACITY} />
        </LinearGradient>
      </Defs>
      <Polygon points={areaPoints} fill={`url(#${gradientId})`} stroke="none" />
      <Polyline
        points={linePoints}
        fill="none"
        stroke={color}
        strokeWidth={SPARKLINE_STROKE_WIDTH}
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
  const series = trend.series && trend.series.length >= MIN_POLYLINE_POINTS ? trend.series : null;
  const directionIcon = series ? null : DIRECTION_ICON[trend.direction || 'flat'];

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
        {series ? (
          <View className="items-end">
            <Sparkline series={series} color={theme.colors.primary} />
          </View>
        ) : directionIcon ? (
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
  // Tabular figures keep the numerals in a column: without them "10" is wider
  // than "1" and every row below the tenth shifts sideways.
  ordinal: { fontVariant: ['tabular-nums'] },
});
