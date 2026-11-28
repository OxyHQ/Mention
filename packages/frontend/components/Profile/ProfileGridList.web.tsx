import { VirtualList } from '@oxy.so/bloom/list';
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Dimensions } from 'react-native';
import {
  defaultProfileGridLayout,
  type ProfileGridEntry,
  type ProfileGridListProps,
} from './ProfileGridList.types';

export type {
  ProfileGridEntry,
  ProfileGridListProps,
} from './ProfileGridList.types';

const OVERSCAN_ROWS = 5;

const rowKey = <T extends ProfileGridEntry>(row: readonly T[]) =>
  `${row[0].postId}:${row[0].mediaIndex}`;

/**
 * Web profile grids share the document scroll owner with the profile shell.
 * Bloom's `VirtualList` windows the grid by row, so a large
 * media history does not mount every thumbnail and no nested overflow container
 * is introduced. The profile shell pages the document itself
 * (`useProfileDocumentPaging`), so the grid asks for nothing.
 */
export function ProfileGridList<T extends ProfileGridEntry>({
  restorationKey,
  data,
  renderCell,
  containerClassName,
  layout = defaultProfileGridLayout,
  leadingComponent,
  emptyComponent,
  listHeaderComponent,
  listStickyHeaderComponent,
}: ProfileGridListProps<T>) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [containerWidth, setContainerWidth] = useState(() => Dimensions.get('window').width);

  const measureGrid = useCallback(() => {
    const rootNode = rootRef.current;
    if (!rootNode) return;
    const { width } = rootNode.getBoundingClientRect();
    setContainerWidth((current) => (current === width ? current : width));
  }, []);

  useLayoutEffect(() => {
    measureGrid();
    if (typeof ResizeObserver === 'undefined') return;
    const resizeObserver = new ResizeObserver(measureGrid);
    if (rootRef.current) resizeObserver.observe(rootRef.current);
    return () => resizeObserver.disconnect();
  }, [measureGrid]);

  const { columns, gap, inset, cellHeight } = layout;
  const itemSize = Math.max(
    1,
    Math.floor((containerWidth - gap * (columns - 1) - inset * 2) / columns),
  );
  const itemHeight = cellHeight?.(itemSize) ?? itemSize;
  const rows = useMemo(() => {
    const next: T[][] = [];
    for (let index = 0; index < data.length; index += columns) {
      next.push(data.slice(index, index + columns));
    }
    return next;
  }, [data, columns]);

  return (
    <div ref={rootRef} className={containerClassName}>
      <VirtualList
        restorationKey={restorationKey}
        data={rows}
        keyExtractor={rowKey}
        estimatedItemSize={itemHeight + gap}
        overscan={OVERSCAN_ROWS}
        ListHeaderComponent={
          <>
            {listHeaderComponent}
            {listStickyHeaderComponent}
            {leadingComponent}
          </>
        }
        ListEmptyComponent={emptyComponent}
        renderItem={({ item: row }) => (
          // The row's own height carries the gap below it, so the measured row
          // spaces the next one exactly as the estimate does.
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: `repeat(${columns}, ${itemSize}px)`,
              gridTemplateRows: `${itemHeight}px`,
              columnGap: gap,
              paddingInline: inset,
              height: itemHeight + gap,
            }}
          >
            {row.map((item) => (
              <div
                key={`${item.postId}:${item.mediaIndex}`}
                style={{ width: itemSize, height: itemHeight }}
              >
                {renderCell(item, itemSize)}
              </div>
            ))}
          </div>
        )}
      />
    </div>
  );
}
