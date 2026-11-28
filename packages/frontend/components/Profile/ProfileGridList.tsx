import type React from 'react';
import { useCallback, useMemo } from 'react';
import { Dimensions, FlatList, View } from 'react-native';
import { useContainerWidth } from '@oxy.so/bloom/hooks';
import { VirtualList } from '@oxy.so/bloom/list';
import {
  defaultProfileGridLayout,
  type ProfileGridEntry,
  type ProfileGridListProps,
} from './ProfileGridList.types';

export type {
  ProfileGridEntry,
  ProfileGridListProps,
} from './ProfileGridList.types';

type ProfileGridRow<T extends ProfileGridEntry> =
  | {
      kind: 'cell';
      key: string;
      value: T;
      columnIndex: number;
    }
  | {
      kind: 'auxiliary';
      key: 'content-header' | 'sticky-header' | 'leading' | 'empty';
      element: React.ReactElement;
    };

/**
 * Shared virtualized grid used by the profile Media and Videos tabs.
 *
 * Native passes `ownsScroll`: the list is then its Screen's scroller (it pads
 * itself clear of the header and the bottom bar) and owns the one viewport,
 * with the profile summary as its normal header and tabs as a full-span sticky
 * data row. Web retains the document-scroll fallback, so no nested scroller is
 * introduced there.
 */
export function ProfileGridList<T extends ProfileGridEntry>({
  data,
  renderCell,
  containerClassName,
  layout = defaultProfileGridLayout,
  leadingComponent,
  initialNumToRender,
  windowSize,
  ownsScroll = false,
  listHeaderComponent,
  listContentHeaderComponent,
  listStickyHeaderComponent,
  emptyComponent,
  contentContainerStyle,
  onEndReached,
}: ProfileGridListProps<T>) {
  const { width, onLayout } = useContainerWidth();
  const containerWidth = width ?? Dimensions.get('window').width;
  const { columns, gap, inset, cellHeight } = layout;
  const itemSize = Math.max(
    1,
    Math.floor((containerWidth - gap * (columns - 1) - inset * 2) / columns),
  );
  const itemHeight = cellHeight?.(itemSize) ?? itemSize;

  const keyExtractor = useCallback(
    (it: T, index: number) => `${it.postId}:${it.mediaIndex ?? index}`,
    [],
  );

  const getItemLayout = useCallback(
    (_: ArrayLike<T> | null | undefined, index: number) => {
      return { length: itemHeight, offset: index * (itemHeight + gap), index };
    },
    [itemHeight, gap],
  );

  const renderItem = useCallback(
    ({ item }: { item: T }) => renderCell(item, itemSize),
    [renderCell, itemSize],
  );

  const rows = useMemo<ProfileGridRow<T>[]>(() => {
    const next: ProfileGridRow<T>[] = [];
    if (listContentHeaderComponent) {
      next.push({
        kind: 'auxiliary',
        key: 'content-header',
        element: listContentHeaderComponent,
      });
    }
    if (listStickyHeaderComponent) {
      next.push({
        kind: 'auxiliary',
        key: 'sticky-header',
        element: listStickyHeaderComponent,
      });
    }
    if (leadingComponent) {
      next.push({ kind: 'auxiliary', key: 'leading', element: leadingComponent });
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
        columnIndex: index % columns,
      });
    }
    return next;
  }, [
    data,
    columns,
    emptyComponent,
    leadingComponent,
    listContentHeaderComponent,
    listStickyHeaderComponent,
  ]);

  const renderVirtualizedRow = useCallback(
    ({ item }: { item: ProfileGridRow<T> }) => {
      if (item.kind === 'auxiliary') {
        return <View className="w-full">{item.element}</View>;
      }
      return (
        <View
          style={{
            width: itemSize,
            marginRight: item.columnIndex < columns - 1 ? gap : 0,
            marginBottom: gap,
          }}
        >
          {renderCell(item.value, itemSize)}
        </View>
      );
    },
    [itemSize, renderCell, columns, gap],
  );

  const virtualizedKeyExtractor = useCallback((item: ProfileGridRow<T>) => item.key, []);

  const getItemType = useCallback((item: ProfileGridRow<T>) => item.kind, []);

  const overrideItemLayout = useCallback(
    (itemLayout: { span?: number }, item: ProfileGridRow<T>) => {
      if (item.kind === 'auxiliary') itemLayout.span = columns;
    },
    [columns],
  );

  if (ownsScroll) {
    return (
      <View className={containerClassName} style={{ flex: 1, minHeight: 0 }} onLayout={onLayout}>
        <VirtualList
          screen={{}}
          data={rows}
          keyExtractor={virtualizedKeyExtractor}
          renderItem={renderVirtualizedRow}
          getItemType={getItemType}
          overrideItemLayout={overrideItemLayout}
          numColumns={columns}
          ListHeaderComponentStyle={{ flexGrow: 0, flexShrink: 0, alignSelf: 'stretch' }}
          contentContainerStyle={[{ paddingHorizontal: inset }, contentContainerStyle]}
          ListHeaderComponent={listHeaderComponent}
          stickyHeaderIndices={
            listStickyHeaderComponent ? [listContentHeaderComponent ? 1 : 0] : undefined
          }
          scrollbar="never"
          onEndReached={onEndReached}
          onEndReachedThreshold={0.7}
          drawDistance={Math.max(itemHeight * 2, 300)}
          maxItemsInRecyclePool={24}
        />
      </View>
    );
  }

  return (
    <View className={containerClassName} onLayout={onLayout}>
      {leadingComponent}
      <FlatList
        data={data}
        keyExtractor={keyExtractor}
        renderItem={renderItem}
        ListEmptyComponent={emptyComponent ?? undefined}
        numColumns={columns}
        columnWrapperStyle={{ gap }}
        contentContainerStyle={{ gap, paddingHorizontal: inset }}
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
