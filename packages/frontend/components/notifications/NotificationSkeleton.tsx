import React from 'react';
import { View } from 'react-native';
import * as Skeleton from '@oxyhq/bloom/skeleton';
import { POST_ITEM_SPACING } from '@/styles/shared';

// Mirrors the real NotificationItem anatomy (single source of truth:
// POST_ITEM_SPACING). AVATAR_SIZE = 40, full-width `border-b border-border py-3`
// rows with the horizontal padding living INSIDE via `px-3` — so the placeholder
// list lands exactly where the real rows will, making the transition seamless.
const AVATAR_SIZE = POST_ITEM_SPACING.AVATAR_SIZE;
const PLACEHOLDER_ROWS = 6;

// One placeholder row: a 40px avatar circle + two stacked text lines (a wider
// byline line, a shorter action line), matching the real row's byline/action
// stack.
const NotificationSkeletonRow: React.FC = () => (
  <View className="w-full border-b border-border py-3">
    <View className="px-3 flex-row items-start">
      <View className="mr-3">
        <Skeleton.Circle size={AVATAR_SIZE} />
      </View>
      <View className="flex-1 gap-2 pt-0.5">
        <Skeleton.Text style={{ fontSize: 15, lineHeight: 20, width: '55%' }} />
        <Skeleton.Text style={{ fontSize: 14, lineHeight: 20, width: '35%' }} />
      </View>
    </View>
  </View>
);

/**
 * Skeleton placeholder for the initial notifications load. Renders a short list
 * of shimmering rows that mimic the real notification rows so the screen feels
 * instant (same treatment the feed uses) instead of a centered spinner.
 */
export const NotificationSkeleton: React.FC = () => (
  <View className="w-full" accessibilityRole="progressbar">
    {Array.from({ length: PLACEHOLDER_ROWS }).map((_, index) => (
      <NotificationSkeletonRow key={index} />
    ))}
  </View>
);

export default NotificationSkeleton;
