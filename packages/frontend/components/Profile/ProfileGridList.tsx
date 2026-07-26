import React, { useCallback, useMemo, useState } from 'react';
import { Dimensions, FlatList, View } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import type {
    ProfileGridEntry,
    ProfileGridListProps,
} from './ProfileGridList.types';

export type {
    ProfileGridEntry,
    ProfileGridListProps,
} from './ProfileGridList.types';

const NUM_COLUMNS = 3;
const GAP = 1; // instagram-like tight spacing
const H_PADDING = 0;

type ProfileGridRow<T extends ProfileGridEntry> =
    | {
        kind: 'cell';
        key: string;
        value: T;
        columnIndex: number;
    }
    | {
        kind: 'auxiliary';
        key: 'sticky-header' | 'empty';
        element: React.ReactElement;
    };

/**
 * Shared 3-column square grid used by the profile Media and Videos tabs.
 *
 * Native passes `ownsScroll`: FlashList then owns the one vertical viewport,
 * with the profile summary as its normal header and tabs as a full-span sticky
 * data row. Web retains the document-scroll fallback, so no nested scroller is
 * introduced there.
 */
export function ProfileGridList<T extends ProfileGridEntry>({
    data,
    renderCell,
    containerClassName,
    initialNumToRender,
    windowSize,
    ownsScroll = false,
    listHeaderComponent,
    listStickyHeaderComponent,
    emptyComponent,
    contentContainerStyle,
    onScroll,
    scrollRef,
    onEndReached,
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

    const rows = useMemo<ProfileGridRow<T>[]>(() => {
        const next: ProfileGridRow<T>[] = [];
        if (listStickyHeaderComponent) {
            next.push({
                kind: 'auxiliary',
                key: 'sticky-header',
                element: listStickyHeaderComponent,
            });
        }
        if (data.length === 0 && emptyComponent) {
            next.push({
                kind: 'auxiliary',
                key: 'empty',
                element: emptyComponent,
            });
        }
        for (const [index, value] of data.entries()) {
            next.push({
                kind: 'cell',
                key: `${value.postId}:${value.mediaIndex ?? index}`,
                value,
                columnIndex: index % NUM_COLUMNS,
            });
        }
        return next;
    }, [data, emptyComponent, listStickyHeaderComponent]);

    const renderVirtualizedRow = useCallback(
        ({ item }: { item: ProfileGridRow<T> }) => {
            if (item.kind === 'auxiliary') {
                return <View className="w-full">{item.element}</View>;
            }
            return (
                <View
                    style={{
                        width: itemSize,
                        marginRight:
                            item.columnIndex < NUM_COLUMNS - 1 ? GAP : 0,
                        marginBottom: GAP,
                    }}
                >
                    {renderCell(item.value, itemSize)}
                </View>
            );
        },
        [itemSize, renderCell],
    );

    const virtualizedKeyExtractor = useCallback(
        (item: ProfileGridRow<T>) => item.key,
        [],
    );

    const getItemType = useCallback(
        (item: ProfileGridRow<T>) => item.kind,
        [],
    );

    const overrideItemLayout = useCallback(
        (
            layout: { span?: number },
            item: ProfileGridRow<T>,
        ) => {
            if (item.kind === 'auxiliary') layout.span = NUM_COLUMNS;
        },
        [],
    );

    if (ownsScroll) {
        return (
            <View
                className={containerClassName}
                style={{ flex: 1, minHeight: 0 }}
                onLayout={(e) => setContainerWidth(e.nativeEvent.layout.width)}
            >
                <FlashList
                    ref={scrollRef}
                    data={rows}
                    keyExtractor={virtualizedKeyExtractor}
                    renderItem={renderVirtualizedRow}
                    getItemType={getItemType}
                    overrideItemLayout={overrideItemLayout}
                    numColumns={NUM_COLUMNS}
                    contentContainerStyle={[
                        { paddingHorizontal: H_PADDING },
                        contentContainerStyle,
                        { paddingBottom: 100 },
                    ]}
                    ListHeaderComponent={listHeaderComponent}
                    stickyHeaderIndices={
                        listStickyHeaderComponent ? [0] : undefined
                    }
                    showsVerticalScrollIndicator={false}
                    onScroll={onScroll}
                    scrollEventThrottle={16}
                    onEndReached={onEndReached}
                    onEndReachedThreshold={0.7}
                    drawDistance={Math.max(itemSize * 2, 300)}
                    maxItemsInRecyclePool={24}
                />
            </View>
        );
    }

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
