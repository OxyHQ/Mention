// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

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
