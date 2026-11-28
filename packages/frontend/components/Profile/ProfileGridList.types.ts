// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import type React from 'react';
import type { View } from 'react-native';

/** Minimal shape every profile-grid entry shares, used for keying + layout. */
export interface ProfileGridEntry {
  postId: string;
  mediaIndex: number;
}

export interface ProfileGridListProps<T extends ProfileGridEntry> {
  /** Viewer, profile and media-filter identity for web measurement restoration. */
  restorationKey: string;
  data: T[];
  /** Render a single square cell given the measured item size. */
  renderCell: (item: T, itemSize: number) => React.ReactElement;
  /** Container className (grids differ only in background/width utilities). */
  containerClassName?: string;
  initialNumToRender?: number;
  windowSize?: number;
  ownsScroll?: boolean;
  listHeaderComponent?: React.ReactElement | null;
  listContentHeaderComponent?: React.ReactElement | null;
  listStickyHeaderComponent?: React.ReactElement | null;
  emptyComponent?: React.ReactElement | null;
  contentContainerStyle?: React.ComponentProps<typeof View>['style'];
  onEndReached?: () => void;
}
