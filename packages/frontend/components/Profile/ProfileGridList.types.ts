import type React from 'react';
import type { View } from 'react-native';

/** Minimal shape every profile-grid entry shares, used for keying + layout. */
export interface ProfileGridEntry {
  postId: string;
  mediaIndex: number;
}

export interface ProfileGridLayout {
  columns: number;
  gap: number;
  inset: number;
  cellHeight?: (width: number) => number;
}

export const defaultProfileGridLayout: ProfileGridLayout = {
  columns: 3,
  gap: 1,
  inset: 0,
};

export interface ProfileGridListProps<T extends ProfileGridEntry> {
  /** Viewer, profile and media-filter identity for web measurement restoration. */
  restorationKey: string;
  data: T[];
  /** Render a cell given its measured width. */
  renderCell: (item: T, itemSize: number) => React.ReactElement;
  /** Container className (grids differ only in background/width utilities). */
  containerClassName?: string;
  layout?: ProfileGridLayout;
  leadingComponent?: React.ReactElement | null;
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
