import React, { memo, useMemo } from 'react';
import { Platform, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { RiArrowDownLine } from '@oxy.so/bloom/icons/RiArrowDownLine';
import { RiArrowUpLine } from '@oxy.so/bloom/icons/RiArrowUpLine';
import { RiMoreFill } from '@oxy.so/bloom/icons/RiMoreFill';
import { Sparkline } from '@oxy.so/bloom/chart-cards';
import { useTheme } from '@oxy.so/bloom/theme';
import { AvatarGroup } from '@oxy.so/bloom/avatar-group';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { MtnConfig } from '@mention/shared-types';
import { getNormalizedUserHandle } from '@oxy.so/core';
import { formatCompactNumber } from '@/utils/formatNumber';
import type { Trend } from '@/interfaces/Trend';
import type { BloomIcon } from '@/components/settings/RowIcon';
import { HIT_SLOP_LG } from '@/styles/hitSlop';

const MS_PER_HOUR = 60 * 60 * 1000;
const HOURS_PER_DAY = 24;

/** Faces shown beside a trend. Matches what the server stores per trend. */
const TREND_FACE_SIZE = 18;

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
const DIRECTION_ICON: Record<Trend['direction'], BloomIcon | null> = {
  up: RiArrowUpLine,
  down: RiArrowDownLine,
  flat: null,
};

const DIRECTION_ICON_SIZE = 16;

// Two points form a line; the server owns the minimum history policy.
const MIN_POLYLINE_POINTS = 2;

/**
 * The line above the name: what KIND of thing this is, and how big it is.
 *
 * Reads the CATEGORY rather than the row's `type`, because `type` is provenance
 * (was it spelled with a `#`) and a reader has no use for that — "Sports" says
 * something, "Trending hashtag" says how the data was stored. Falls back to a
 * bare "Trending" when nothing was assigned; never invents a category.
 *
 * The count is DISTINCT AUTHORS when known, not posts: it is the number the
 * trend actually qualified on, and "312 people" is a far stronger claim than
 * "312 posts", which one account could have written.
 */
function getTrendLabel(trend: Trend, t: TFunction): string {
  const category = trend.category
    ? t(`trend.category.${trend.category}`, { defaultValue: '' })
    : '';
  const kind = category || t('trend.trendingLabel', { defaultValue: 'Trending' });

  if (trend.authorCount && trend.authorCount > 0) {
    return `${kind} · ${t('trend.peopleCount', {
      count: trend.authorCount,
      formatted: formatCompactNumber(trend.authorCount),
      defaultValue: `${formatCompactNumber(trend.authorCount)} people`,
    })}`;
  }
  if (trend.volume > 0) {
    return `${kind} · ${t('trend.postCount', {
      count: trend.volume,
      formatted: formatCompactNumber(trend.volume),
      defaultValue: `${formatCompactNumber(trend.volume)} posts`,
    })}`;
  }
  return kind;
}

/**
 * How long this run of the trend has been going, as a badge.
 *
 * `hot` outranks age: it is the stronger claim and the two would otherwise
 * compete for the same corner. Below the `new` window the badge is the age
 * itself, which is more informative than a second adjective — and a trend with
 * no `startedAt` (written before onset tracking) gets NO badge rather than a
 * guessed one.
 */
function getTrendBadge(trend: Trend, t: TFunction): { text: string; tone: 'hot' | 'new' | 'age' } | null {
  if (trend.status === 'hot') {
    return { text: t('trend.badge.hot', { defaultValue: 'Hot' }), tone: 'hot' };
  }
  if (!trend.startedAt) return null;

  const startedAt = Date.parse(trend.startedAt);
  if (Number.isNaN(startedAt)) return null;

  const ageMs = Date.now() - startedAt;
  if (ageMs < 0) return null;
  if (ageMs < MtnConfig.trending.detection.newTrendMaxAgeMs) {
    return { text: t('trend.badge.new', { defaultValue: 'New' }), tone: 'new' };
  }

  const hours = Math.floor(ageMs / MS_PER_HOUR);
  if (hours < HOURS_PER_DAY) {
    return { text: t('trend.badge.hoursAgo', { count: hours, defaultValue: `${hours}h` }), tone: 'age' };
  }
  const days = Math.floor(hours / HOURS_PER_DAY);
  return { text: t('trend.badge.daysAgo', { count: days, defaultValue: `${days}d` }), tone: 'age' };
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
  const { t } = useTranslation();
  const isLarge = size === 'large';
  const series = trend.series && trend.series.length >= MIN_POLYLINE_POINTS ? trend.series : null;
  const DirectionIcon = series ? null : DIRECTION_ICON[trend.direction || 'flat'];
  const badge = getTrendBadge(trend, t);
  // Faces are evidence that real accounts are behind the trend, so they only
  // appear where there is room to read them alongside everything else.
  const faces = useMemo(
    () =>
      isLarge
        ? (trend.actors ?? []).map((actor) => ({
            id: actor.id,
            uri: actor.avatar,
            displayName: actor.name?.displayName,
            username: getNormalizedUserHandle(actor) ?? undefined,
          }))
        : [],
    [isLarge, trend.actors],
  );

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
          <View className="flex-row items-center mb-0.5">
            <Text className={`text-muted-foreground ${isLarge ? 'text-[13px]' : 'text-[12px]'}`}>
              {getTrendLabel(trend, t)}
            </Text>
            {badge ? (
              <View
                className={`ml-2 rounded-full px-1.5 py-0.5 ${
                  badge.tone === 'hot'
                    ? 'bg-destructive/10'
                    : badge.tone === 'new'
                      ? 'bg-primary/10'
                      : 'bg-muted'
                }`}
              >
                <Text
                  className={`text-[11px] font-semibold ${
                    badge.tone === 'hot'
                      ? 'text-destructive'
                      : badge.tone === 'new'
                        ? 'text-primary'
                        : 'text-muted-foreground'
                  }`}
                >
                  {badge.text}
                </Text>
              </View>
            ) : null}
          </View>
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
            {trend.displayName || trend.text}
          </Text>
          {trend.description ? (
            <Text
              className={`text-muted-foreground ${isLarge ? 'text-[13px] mt-1' : 'text-[12px] mt-0.5'}`}
              numberOfLines={isLarge ? 2 : 1}
            >
              {trend.description}
            </Text>
          ) : null}
          {faces.length > 0 ? (
            <View className="mt-1.5 flex-row">
              <AvatarGroup items={faces} size={TREND_FACE_SIZE} max={faces.length} />
            </View>
          ) : null}
        </View>
        {series ? (
          <View className="items-end">
            <Sparkline data={series} width={50} height={24} shape="sharp" color={theme.colors.primary} />
          </View>
        ) : DirectionIcon ? (
          <View className="items-end">
            <DirectionIcon
              width={DIRECTION_ICON_SIZE}
              height={DIRECTION_ICON_SIZE}
              fill={theme.colors.textSecondary}
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
          <RiMoreFill size="sm" fill={theme.colors.textSecondary} />
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
