import type React from 'react';
import type { FlatList, View } from 'react-native';

/** Minimal shape every profile-grid entry shares, used for keying + layout. */
export interface ProfileGridEntry {
    postId: string;
    mediaIndex: number;
}

export interface ProfileGridListProps<T extends ProfileGridEntry> {
    data: T[];
    /** Render a single square cell given the measured item size. */
    renderCell: (item: T, itemSize: number) => React.ReactElement;
    /** Container className (grids differ only in background/width utilities). */
    containerClassName?: string;
    initialNumToRender?: number;
    windowSize?: number;
    ownsScroll?: boolean;
    listHeaderComponent?: React.ReactElement | null;
    listStickyHeaderComponent?: React.ReactElement | null;
    emptyComponent?: React.ReactElement | null;
    contentContainerStyle?: React.ComponentProps<typeof View>['style'];
    onScroll?: React.ComponentProps<typeof FlatList<T>>['onScroll'];
    scrollRef?: (node: unknown | null) => void;
    onEndReached?: () => void;
}
