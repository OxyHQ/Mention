import { VirtualList } from '@oxy.so/bloom/list';
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Dimensions } from 'react-native';
import type { ProfileGridEntry, ProfileGridListProps } from './ProfileGridList.types';

export type {
  ProfileGridEntry,
  ProfileGridListProps,
} from './ProfileGridList.types';

const NUM_COLUMNS = 3;
const GAP = 1;
const OVERSCAN_ROWS = 5;

const rowKey = <T extends ProfileGridEntry>(row: readonly T[]) =>
  `${row[0].postId}:${row[0].mediaIndex}`;

/**
 * Web profile grids share the document scroll owner with the profile shell.
 * Bloom's `VirtualList` windows the grid by ROW (three cells each), so a large
 * media history does not mount every thumbnail and no nested overflow container
 * is introduced. The profile shell pages the document itself
 * (`useProfileDocumentPaging`), so the grid asks for nothing.
 */
export function ProfileGridList<T extends ProfileGridEntry>({
  restorationKey,
  data,
  renderCell,
  containerClassName,
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

  const itemSize = Math.max(
    1,
    Math.floor(Math.max(containerWidth - GAP * (NUM_COLUMNS - 1), NUM_COLUMNS) / NUM_COLUMNS),
  );
  const rows = useMemo(() => {
    const next: T[][] = [];
    for (let index = 0; index < data.length; index += NUM_COLUMNS) {
      next.push(data.slice(index, index + NUM_COLUMNS));
    }
    return next;
  }, [data]);

  return (
    <div ref={rootRef} className={containerClassName}>
      <VirtualList
        restorationKey={restorationKey}
        data={rows}
        keyExtractor={rowKey}
        estimatedItemSize={itemSize + GAP}
        overscan={OVERSCAN_ROWS}
        ListHeaderComponent={
          <>
            {listHeaderComponent}
            {listStickyHeaderComponent}
          </>
        }
        ListEmptyComponent={emptyComponent}
        renderItem={({ item: row }) => (
          // The row's own height carries the gap below it, so the measured row
          // spaces the next one exactly as the estimate does.
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: `repeat(${NUM_COLUMNS}, ${itemSize}px)`,
              gridTemplateRows: `${itemSize}px`,
              columnGap: GAP,
              height: itemSize + GAP,
            }}
          >
            {row.map((item) => (
              <div
                key={`${item.postId}:${item.mediaIndex}`}
                style={{ width: itemSize, height: itemSize }}
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
