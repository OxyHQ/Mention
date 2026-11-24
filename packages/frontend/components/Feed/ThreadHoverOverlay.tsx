import { useEffect } from 'react';
import type { SharedValue } from 'react-native-reanimated';
import { SubtleHover } from '@oxy.so/bloom/subtle-hover';
import { leaveThreadHover, useThreadHoverStore } from '@/stores/threadHoverStore';

/**
 * Only a thread's overlay subscribes; hover does not re-render the post.
 * `pressed` is the row's own press highlight (`usePressHighlight`), drawn here
 * on iOS since the overlay is the row's wash.
 */
export function ThreadHoverOverlay({
  sliceKey,
  owner,
  visible = true,
  pressed,
}: {
  sliceKey: string;
  owner: object;
  visible?: boolean;
  pressed?: SharedValue<number>;
}) {
  const active = useThreadHoverStore((state) => state.hoveredSliceKey === sliceKey);
  // A virtualized row may disappear or be reused without receiving hover-out.
  useEffect(() => () => leaveThreadHover(owner, sliceKey), [owner, sliceKey]);
  return visible ? <SubtleHover active={active} pressed={pressed} /> : null;
}
