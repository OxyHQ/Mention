import React, { memo } from 'react';
import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Skeleton from '@oxyhq/bloom/skeleton';
import { useTheme } from '@oxyhq/bloom/theme';
import { POST_ITEM_SPACING } from '@/styles/shared';
import { CHANNEL_AVATAR_SIZE } from './ChannelHeader';
import { LAYOUT } from './types';

/**
 * Loading skeleton for the profile screen.
 *
 * Mirrors the loaded profile anatomy element-for-element so the swap to real
 * data produces no layout shift:
 *  - a full-bleed banner (LAYOUT.HEADER_HEIGHT_EXPANDED + _NARROWED tall),
 *    absolute like the real screen's banner;
 *  - the content offset by the SAME `marginTop` / `paddingTop` the real screen
 *    applies (ProfileScreen's scrollView + contentContainer), so every element
 *    below lands at its identical final Y;
 *  - the avatar (90px, 3px background ring) overlapping the banner by 45px — the
 *    exact `marginTop: -45` ProfileHeader uses — with a placeholder
 *    action row (button + icon) on the right;
 *  - display-name + handle bars, a 2-line bio, the meta row and the stats row
 *    (mirroring ProfileContent → ProfileMeta / ProfileStats);
 *  - the tab bar (matching AnimatedTabBar's border + `py-2.5` cells); and
 *  - a few post-row placeholders matching the feed's POST_ITEM_SPACING.
 *
 * All blocks use Bloom's shimmer primitives (theme-aware `contrast50` fill +
 * a self-driven opacity loop) so it stays consistent with the app's other
 * skeletons (feed / notifications / cards).
 */

// Full-bleed banner height = expanded + narrowed header bands (matches the real
// banner rendered in ProfileScreen).
const BANNER_HEIGHT = LAYOUT.HEADER_HEIGHT_EXPANDED + LAYOUT.HEADER_HEIGHT_NARROWED;
// Header avatar footprint + the negative pull that overlaps it onto the banner
// (mirrors ProfileHeader: a 90px avatar with `marginTop: -45`).
const AVATAR_SIZE = 90;
const AVATAR_RING = 3;
const HEADER_OVERLAP = 45;
// Representative widths for the five stat clusters (following / followers /
// posts / boosts / replies) and the profile tab labels.
const STAT_CHIP_WIDTHS = [96, 104, 78, 84, 90];
const TAB_CHIP_WIDTHS = [42, 54, 50, 58, 44, 56];
const FEED_ROW_COUNT = 4;

// A CHANNEL's anatomy, which is a different shape rather than a smaller one: no
// banner to overlap, a CENTRED masthead (avatar, then name, then handle, then
// the follow control), four stats (no replies — a channel can author none) and
// four tabs. Mirrors `ChannelHeader` + `useProfileChrome({ hasBannerBand:
// false })`.
//
// The avatar size is IMPORTED rather than restated: it is the one measurement
// where a disagreement between this file and the header is a visible jump at
// the moment the data lands.
const CHANNEL_CONTENT_OFFSET = 60;
const CHANNEL_STAT_CHIP_WIDTHS = [96, 104, 78, 84];
const CHANNEL_TAB_CHIP_WIDTHS = [42, 50, 58, 56];

/**
 * One placeholder feed row, mirroring the real post row (PostItem) via the
 * shared POST_ITEM_SPACING: a 40px avatar + a byline line and two body lines,
 * inside a `border-b border-border py-3` row with `px-3` gutters — so the rows
 * land exactly where the real feed will paint.
 */
const FeedRowSkeleton = memo(function FeedRowSkeleton() {
  return (
    <View className="w-full border-b border-border py-3">
      <View className="px-3 flex-row items-start">
        <View className="mr-3">
          <Skeleton.Circle size={POST_ITEM_SPACING.AVATAR_SIZE} />
        </View>
        <View className="flex-1 gap-2 pt-0.5">
          <Skeleton.Box width="40%" height={14} borderRadius={6} />
          <Skeleton.Box width="94%" height={14} borderRadius={6} />
          <Skeleton.Box width="72%" height={14} borderRadius={6} />
        </View>
      </View>
    </View>
  );
});

export interface ProfileSkeletonProps {
  /**
   * Which anatomy to mirror. A skeleton exists to hold the exact space the real
   * content will occupy, so drawing a person's banner and 90px overlapping
   * avatar in front of a channel is not a cosmetic mismatch — it is a layout
   * shift at the moment the data lands, which is the one thing a skeleton is
   * for.
   */
  variant?: 'person' | 'channel';
}

export const ProfileSkeleton = memo(function ProfileSkeleton({
  variant = 'person',
}: ProfileSkeletonProps = {}) {
  const insets = useSafeAreaInsets();
  const theme = useTheme();

  if (variant === 'channel') {
    return (
      <View className="flex-1 bg-background" accessibilityRole="progressbar">
        <View style={{ paddingTop: insets.top + CHANNEL_CONTENT_OFFSET }}>
          <View className="bg-background px-4 pb-4">
            {/* Centred masthead — avatar, then name, then handle. The margins
                are `ChannelHeader`'s own: the name Text carries `marginTop: 12,
                marginBottom: 4` and the handle sits straight under it, so the
                placeholders repeat those as `mt-3` / `mb-1` rather than a
                rhythm of their own.
                Each bar is drawn SHORTER than the line it stands in — a
                full-height slab reads as a block, not a line — so it is centred
                inside a wrapper of the line's TRUE height: `h-7` (28px) for the
                24px display name, `h-5` (20px) for the 15px/20 handle. Measured
                in a browser: without the wrappers the masthead came out 12px
                short and everything below it, the follow control and the tab
                strip included, sat 12px high and jumped when the data landed —
                which is the exact defect a skeleton exists to prevent. */}
            <View className="items-center w-full">
              <Skeleton.Circle
                size={CHANNEL_AVATAR_SIZE}
                style={{ borderWidth: AVATAR_RING, borderColor: theme.colors.background }}
              />
              <View className="mt-3 mb-1 h-7 justify-center">
                <Skeleton.Box width={180} height={22} borderRadius={6} />
              </View>
              <View className="h-5 justify-center">
                <Skeleton.Box width={110} height={14} borderRadius={6} />
              </View>
            </View>

            {/* Follow button — the whole action row, and the last element of the
                centred masthead; a channel has no poke and no self view. */}
            <View className="mt-4 mb-4 flex-row justify-center">
              <Skeleton.Box width={92} height={36} borderRadius={999} />
            </View>

            <View className="mb-3 gap-2">
              <Skeleton.Box width="92%" height={14} borderRadius={6} />
              <Skeleton.Box width="78%" height={14} borderRadius={6} />
            </View>

            <View className="flex-row flex-wrap mb-3 gap-x-4 gap-y-1">
              <Skeleton.Box width={110} height={15} borderRadius={6} />
              <Skeleton.Box width={150} height={15} borderRadius={6} />
            </View>

            <View className="flex-row flex-wrap gap-x-4 gap-y-2">
              {CHANNEL_STAT_CHIP_WIDTHS.map((width, index) => (
                <Skeleton.Box key={index} width={width} height={15} borderRadius={6} />
              ))}
            </View>
          </View>

          <View className="border-b border-border bg-background flex-row">
            {CHANNEL_TAB_CHIP_WIDTHS.map((width, index) => (
              <View key={index} className="items-center py-2.5 px-3 min-w-[60px]">
                <Skeleton.Box width={width} height={14} borderRadius={6} />
                {index === 0 && (
                  <View className="absolute bottom-0 left-3 right-3 h-0.5 rounded-t bg-primary" />
                )}
              </View>
            ))}
          </View>

          {Array.from({ length: FEED_ROW_COUNT }).map((_, index) => (
            <FeedRowSkeleton key={index} />
          ))}
        </View>
      </View>
    );
  }

  return (
    <View className="flex-1 bg-background" accessibilityRole="progressbar">
      {/* Full-bleed banner — absolute like the real screen so it does not push
          the content down; dampened (`blend`) so the avatar placeholder reads
          clearly over it. */}
      <View className="absolute left-0 right-0 top-0">
        <Skeleton.Box blend width="100%" height={BANNER_HEIGHT} borderRadius={0} />
      </View>

      {/* Content offset by the SAME marginTop + paddingTop the loaded profile
          applies (ProfileScreen: scrollView marginTop = HEADER_HEIGHT_NARROWED,
          contentContainer paddingTop = HEADER_HEIGHT_EXPANDED - insets.top), so
          every element below lands at its final Y and the banner shows through
          this transparent top gutter. */}
      <View style={{ marginTop: LAYOUT.HEADER_HEIGHT_NARROWED, paddingTop: LAYOUT.HEADER_HEIGHT_EXPANDED - insets.top }}>
        {/* Profile info block — mirrors ProfileContent's padding + background. */}
        <View className="bg-background px-4 pb-4">
          {/* Header row: avatar overlapping the banner + action placeholders.
              `marginTop: -45` matches ProfileHeader so the avatar lands
              at the identical Y. */}
          <View className="flex-row justify-between items-end mb-2.5" style={{ marginTop: -HEADER_OVERLAP }}>
            <Skeleton.Circle
              size={AVATAR_SIZE}
              style={{ borderWidth: AVATAR_RING, borderColor: theme.colors.background }}
            />
            <View className="flex-row items-center gap-3">
              <Skeleton.Box width={92} height={36} borderRadius={999} />
              <Skeleton.Circle size={40} />
            </View>
          </View>

          {/* Display name (fontSize 24) + handle (fontSize 15). */}
          <View className="mt-2.5 mb-1">
            <Skeleton.Box width="55%" height={22} borderRadius={6} />
          </View>
          <View className="mb-3">
            <Skeleton.Box width="32%" height={14} borderRadius={6} />
          </View>

          {/* Bio (two lines). */}
          <View className="mb-3 gap-2">
            <Skeleton.Box width="92%" height={14} borderRadius={6} />
            <Skeleton.Box width="78%" height={14} borderRadius={6} />
          </View>

          {/* Meta row (location · joined). */}
          <View className="flex-row flex-wrap mb-3 gap-x-4 gap-y-1">
            <Skeleton.Box width={110} height={15} borderRadius={6} />
            <Skeleton.Box width={150} height={15} borderRadius={6} />
          </View>

          {/* Stats row (following / followers / posts / boosts / replies). */}
          <View className="flex-row flex-wrap gap-x-4 gap-y-2">
            {STAT_CHIP_WIDTHS.map((width, index) => (
              <Skeleton.Box key={index} width={width} height={15} borderRadius={6} />
            ))}
          </View>
        </View>

        {/* Tab bar — matches AnimatedTabBar (bottom border, `py-2.5 px-3`
            min-60 cells) with an active-indicator hint under the first tab. */}
        <View className="border-b border-border bg-background flex-row">
          {TAB_CHIP_WIDTHS.map((width, index) => (
            <View key={index} className="items-center py-2.5 px-3 min-w-[60px]">
              <Skeleton.Box width={width} height={14} borderRadius={6} />
              {index === 0 && (
                <View className="absolute bottom-0 left-3 right-3 h-0.5 rounded-t bg-primary" />
              )}
            </View>
          ))}
        </View>

        {/* Placeholder feed rows below the tab bar. */}
        {Array.from({ length: FEED_ROW_COUNT }).map((_, index) => (
          <FeedRowSkeleton key={index} />
        ))}
      </View>
    </View>
  );
});
