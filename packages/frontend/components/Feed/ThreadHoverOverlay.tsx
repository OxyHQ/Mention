import { useEffect } from 'react';
import { SubtleHover } from '@oxy.so/bloom/subtle-hover';
import { leaveThreadHover, useThreadHoverStore } from '@/stores/threadHoverStore';

/** Only a thread's overlay subscribes; hover does not re-render the post. */
export function ThreadHoverOverlay({
  sliceKey,
  owner,
  visible = true,
}: {
  sliceKey: string;
  owner: object;
  visible?: boolean;
}) {
  const active = useThreadHoverStore((state) => state.hoveredSliceKey === sliceKey);
  // A virtualized row may disappear or be reused without receiving hover-out.
  useEffect(() => () => leaveThreadHover(owner, sliceKey), [owner, sliceKey]);
  return visible ? <SubtleHover active={active} /> : null;
}
