import React, { useCallback, useMemo, useState } from 'react';
import { Dimensions, FlatList, View } from 'react-native';

const NUM_COLUMNS = 3;
const GAP = 1; // instagram-like tight spacing
const H_PADDING = 0;

/** Minimal shape every profile-grid entry shares, used for keying + layout. */
export interface ProfileGridEntry {
    postId: string;
    mediaIndex: number;
}

interface ProfileGridListProps<T extends ProfileGridEntry> {
    data: T[];
    /** Render a single square cell given the measured item size. */
    renderCell: (item: T, itemSize: number) => React.ReactElement;
    /** Container className (grids differ only in background/width utilities). */
    containerClassName?: string;
    initialNumToRender?: number;
    windowSize?: number;
}

/**
 * Shared 3-column, non-scrolling square grid used by the profile Media and
 * Videos tabs. Owns width measurement, item sizing, virtualization tuning and
 * the FlatList shell; callers supply only how to render one cell. The list is
 * intentionally non-scrollable (it nests inside the profile's parent
 * ScrollView) and measures its own width via `onLayout`.
 */
export function ProfileGridList<T extends ProfileGridEntry>({
    data,
    renderCell,
    containerClassName,
    initialNumToRender,
    windowSize,
}: ProfileGridListProps<T>) {
    const [containerWidth, setContainerWidth] = useState<number>(Dimensions.get('window').width);
    const itemSize = useMemo(() => {
        const totalGap = GAP * (NUM_COLUMNS - 1) + H_PADDING * 2;
        return Math.floor((containerWidth - totalGap) / NUM_COLUMNS);
    }, [containerWidth]);

    const keyExtractor = useCallback((it: T, index: number) => `${it.postId}:${it.mediaIndex ?? index}`, []);

    const getItemLayout = useCallback((_: ArrayLike<T> | null | undefined, index: number) => {
        const row = Math.floor(index / NUM_COLUMNS);
        return { length: itemSize, offset: row * (itemSize + GAP), index };
    }, [itemSize]);

    const renderItem = useCallback(
        ({ item }: { item: T }) => renderCell(item, itemSize),
        [renderCell, itemSize],
    );

    return (
        <View className={containerClassName} onLayout={(e) => setContainerWidth(e.nativeEvent.layout.width)}>
            <FlatList
                data={data}
                keyExtractor={keyExtractor}
                renderItem={renderItem}
                numColumns={NUM_COLUMNS}
                columnWrapperStyle={{ gap: GAP }}
                contentContainerStyle={{ gap: GAP, paddingHorizontal: H_PADDING }}
                showsVerticalScrollIndicator={false}
                scrollEnabled={false}
                nestedScrollEnabled={false}
                removeClippedSubviews
                initialNumToRender={initialNumToRender}
                windowSize={windowSize}
                getItemLayout={getItemLayout}
            />
        </View>
    );
}
