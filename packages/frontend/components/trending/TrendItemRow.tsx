import { AccountAvatarGroup } from '@/components/ui/AccountAvatarGroup';
import { memo, useMemo } from 'react';
import { StyleSheet, TouchableOpacity, View, type ViewStyle } from 'react-native';
import { RiArrowDownLine } from '@oxy.so/bloom/icons/RiArrowDownLine';
import { RiArrowUpLine } from '@oxy.so/bloom/icons/RiArrowUpLine';
import { Sparkline } from '@oxy.so/bloom/chart-cards/sparkline';
import { useColorTokens, useTheme } from '@oxy.so/bloom/theme';
import * as Skeleton from '@oxy.so/bloom/skeleton';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { getNormalizedUserHandle } from '@oxy.so/core';
import { MEDIA_VARIANT_AVATAR } from '@mention/shared-types/post';
import { formatCompactNumber } from '@/utils/formatNumber';
import { WidgetItemMenu, type WidgetItemMenuActions } from '@/components/widgets/WidgetItemMenu';
import type { Trend } from '@/interfaces/Trend';
import type { BloomIcon } from '@/components/settings/RowIcon';
import { getTrendBadge } from './trendBadge';

import { Embed, HStack, RawText, VStack, toElement } from '@oxy.so/bloom-language';

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

interface TrendItemRowProps {
  trend: Trend;
  onPress: (trend: Trend) => void;
  /** What the ⋯ menu of this trend does; omit to hide the button. */
  getMenuActions?: (trend: Trend) => WidgetItemMenuActions;
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
  getMenuActions,
  showBorder = false,
  size = 'compact',
  ordinal,
}: TrendItemRowProps) {
  const theme = useTheme();
  const colors = useColorTokens();
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
            kind: actor.kind,
            character: actor.character,
            color: actor.color,
            displayName: actor.name?.displayName,
            username: getNormalizedUserHandle(actor) ?? undefined,
          }))
        : [],
    [isLarge, trend.actors],
  );

  return (
    <TouchableOpacity
      style={[
        classStyles.row,
        isLarge ? classStyles.rowLarge : classStyles.rowCompact,
        showBorder && styles.itemBorder,
        showBorder && { borderColor: colors.border },
      ]}
      onPress={() => onPress(trend)}
      activeOpacity={0.7}
    >
      {/*
        Top-aligned, not centred: the title may now wrap to two lines, and a
        vertically centred ordinal would float against the middle of the text
        block instead of sitting beside the row it numbers.
      */}
      {toElement(
        HStack(
          ordinal !== undefined
            ? RawText(ordinal)
                .foreground('muted')
                .margin('right', 'sm')
                .weight('semibold')
                .font(isLarge ? 'md' : 'sm')
                // Tabular figures keep the numerals in a column: without them "10" is
                // wider than "1" and every row below the tenth shifts sideways.
                .monospacedDigit()
            : null,
          VStack(
            HStack(
              RawText(getTrendLabel(trend, t))
                .foreground('muted')
                .font(isLarge ? 'sm' : 'xs'),
              badge
                ? VStack(
                    RawText(badge.text)
                      .font('11')
                      .weight('semibold')
                      .foreground(
                        badge.tone === 'hot'
                          ? 'destructive'
                          : badge.tone === 'new'
                            ? 'primary'
                            : 'muted',
                      ),
                  )
                    .padding('horizontal', '6')
                    .padding('vertical', '2xs')
                    .background(
                      badge.tone === 'hot'
                        ? 'destructive/10'
                        : badge.tone === 'new'
                          ? 'primary/10'
                          : 'mutedFill',
                    )
                    .corner('infinite')
                    .margin('left', 'sm')
                : null,
            )
              .align('center')
              .margin('bottom', '2xs'),
            /*
                  Wraps to a second line rather than truncating at one: the leading
                  ordinal takes horizontal space away from the title, and the widget
                  column is the narrowest surface a trend is shown in, so a long
                  multi-word name would otherwise be cut mid-word. Two lines is the
                  cap — beyond that a runaway name would push the whole list down.
                */ RawText(trend.displayName || trend.text)
              .foreground('foreground')
              .weight('bold')
              .font(isLarge ? '16' : '14')
              .lines(2),
            trend.description
              ? RawText(trend.description)
                  .foreground('muted')
                  .font(isLarge ? 'sm' : 'xs')
                  .margin('top', isLarge ? 'xs' : '2xs')
                  .lines(isLarge ? 2 : 1)
              : null,
            faces.length > 0
              ? HStack(
                  Embed(
                    <AccountAvatarGroup
                      items={faces}
                      size={TREND_FACE_SIZE}
                      max={faces.length}
                      variant={MEDIA_VARIANT_AVATAR}
                    />,
                  ),
                ).margin('top', '6')
              : null,
          )
            .flex('1')
            .margin('right', 'md'),
          Embed(
            series
              ? toElement(
                  VStack(
                    Embed(
                      <Sparkline
                        data={series}
                        width={50}
                        height={24}
                        shape="sharp"
                        color={theme.colors.primary}
                      />,
                    ),
                  ).align('end'),
                )
              : DirectionIcon
                ? toElement(
                    VStack(
                      Embed(
                        <DirectionIcon
                          width={DIRECTION_ICON_SIZE}
                          height={DIRECTION_ICON_SIZE}
                          fill={theme.colors.textSecondary}
                        />,
                      ),
                    ).align('end'),
                  )
                : null,
          ),
        )
          .flex('1')
          .align('start')
          .justify('between')
          .margin('right', 'sm'),
      )}
      {getMenuActions ? <WidgetItemMenu label={trend.text} {...getMenuActions(trend)} /> : null}
    </TouchableOpacity>
  );
});

/**
 * A compact row's placeholder, built from the row's own box model: the same
 * vertical padding and hairline, a label line as tall as the label row with its
 * badge (16) plus its 2px gap, a one-line title (16), and the 24px menu button.
 * A list of these is as tall as the list of trends that replaces it, so nothing
 * below it moves when they arrive (#1216 measured 76px for five rows).
 */
export function TrendItemRowSkeleton({ showBorder = false }: { showBorder?: boolean }) {
  const colors = useColorTokens();
  return (
    <View
      style={[
        classStyles.row,
        classStyles.rowCompact,
        showBorder && styles.itemBorder,
        showBorder && { borderColor: colors.border },
      ]}
    >
      {toElement(
        VStack(
          /* The gap is the label row's own `mb-0.5`; Skeleton.Text reads only its width and line height. */ VStack(
            Embed(<Skeleton.Text style={{ lineHeight: 16, width: 120 }} />),
          ).margin('bottom', '2xs'),
          Embed(<Skeleton.Text style={{ lineHeight: 16, width: 160 }} />),
        )
          .flex('1')
          .margin('right', 'sm'),
      )}
      {toElement(VStack(Embed(<Skeleton.Circle size={16} />)).padding('all', 'xs'))}
    </View>
  );
}

const styles = StyleSheet.create({
  itemBorder: { borderBottomWidth: 0.5 },
});

// The row stays React Native's TouchableOpacity (the language has no node for its
// fading press; it is a pointer on the web already); this draws its classes.
const classStyles = {
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  rowLarge: { paddingVertical: 12 },
  rowCompact: { paddingVertical: 6 },
} satisfies Record<string, ViewStyle>;
