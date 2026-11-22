import type React from 'react';
import * as Skeleton from '@oxy.so/bloom/skeleton';
import { POST_ITEM_SPACING } from '@/styles/shared';
import { Embed, HStack, VStack, toElement } from '@oxy.so/bloom-language';

// Mirrors the real NotificationItem anatomy (single source of truth:
// POST_ITEM_SPACING). AVATAR_SIZE = 40, full-width `border-b border-border py-3`
// rows with the horizontal padding living INSIDE via `px-3` — so the placeholder
// list lands exactly where the real rows will, making the transition seamless.
const AVATAR_SIZE = POST_ITEM_SPACING.AVATAR_SIZE;
const PLACEHOLDER_ROWS = 6;

// One placeholder row: a 40px avatar circle + two stacked text lines (a wider
// byline line, a shorter action line), matching the real row's byline/action
// stack.
const NotificationSkeletonRow: React.FC = () =>
  toElement(
    VStack(
      HStack(
        VStack(Embed(<Skeleton.Circle size={AVATAR_SIZE} />)).margin('right', 'md'),
        VStack(
          Embed(<Skeleton.Text style={{ fontSize: 15, lineHeight: 20, width: '55%' }} />),
          Embed(<Skeleton.Text style={{ fontSize: 14, lineHeight: 20, width: '35%' }} />),
        )
          .padding('top', '2xs')
          .flex('1')
          .spacing('sm'),
      )
        .padding('horizontal', 'md')
        .align('start'),
    )
      .padding('vertical', 'md')
      .frame({ width: 'full' })
      .border('border', 'thin', 'bottom'),
  );

/**
 * Skeleton placeholder for the initial notifications load. Renders a short list
 * of shimmering rows that mimic the real notification rows so the screen feels
 * instant (same treatment the feed uses) instead of a centered spinner.
 */
export const NotificationSkeleton: React.FC<{ count?: number }> = ({
  count = PLACEHOLDER_ROWS,
}) => (
  <Skeleton.Region className="w-full">
    {Array.from({ length: count }).map((_, index) => (
      <NotificationSkeletonRow key={index} />
    ))}
  </Skeleton.Region>
);
