import React, { memo } from 'react';
import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Skeleton from '@oxyhq/bloom/skeleton';
import { useTheme } from '@oxyhq/bloom/theme';
import { POST_ITEM_SPACING } from '@/styles/shared';
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
 *    exact `marginTop: -45` ProfileHeaderDefault uses — with a placeholder
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
// (mirrors ProfileHeaderDefault: a 90px avatar with `marginTop: -45`).
const AVATAR_SIZE = 90;
const AVATAR_RING = 3;
const HEADER_OVERLAP = 45;
// Representative widths for the five stat clusters (following / followers /
// posts / boosts / replies) and the profile tab labels.
const STAT_CHIP_WIDTHS = [96, 104, 78, 84, 90];
const TAB_CHIP_WIDTHS = [42, 54, 50, 58, 44, 56];
const FEED_ROW_COUNT = 4;

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

export const ProfileSkeleton = memo(function ProfileSkeleton() {
  const insets = useSafeAreaInsets();
  const theme = useTheme();

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
              `marginTop: -45` matches ProfileHeaderDefault so the avatar lands
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
