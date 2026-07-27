import React, {
    useCallback,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
} from 'react';
import { Dimensions } from 'react-native';
import { useWindowVirtualizer } from '@tanstack/react-virtual';
import type {
    ProfileGridEntry,
    ProfileGridListProps,
} from './ProfileGridList.types';

export type {
    ProfileGridEntry,
    ProfileGridListProps,
} from './ProfileGridList.types';

const NUM_COLUMNS = 3;
const GAP = 1;
const H_PADDING = 0;
const OVERSCAN_ROWS = 5;

/**
 * Web profile grids share the document scroll owner with the profile shell.
 * Rows are window-virtualized, so a large media history does not mount every
 * thumbnail and no nested overflow container is introduced.
 */
export function ProfileGridList<T extends ProfileGridEntry>({
    data,
    renderCell,
    containerClassName,
    emptyComponent,
    listHeaderComponent,
    listStickyHeaderComponent,
}: ProfileGridListProps<T>) {
    const rootRef = useRef<HTMLDivElement | null>(null);
    const gridRef = useRef<HTMLDivElement | null>(null);
    const [containerWidth, setContainerWidth] = useState(
        () => Dimensions.get('window').width,
    );
    const [scrollMargin, setScrollMargin] = useState(0);

    const measureGrid = useCallback(() => {
        const rootNode = rootRef.current;
        const gridNode = gridRef.current;
        if (!rootNode || !gridNode || typeof window === 'undefined') return;

        const rect = rootNode.getBoundingClientRect();
        setContainerWidth((current) => (
            current === rect.width ? current : rect.width
        ));
        const nextScrollMargin =
            gridNode.getBoundingClientRect().top + window.scrollY;
        setScrollMargin((current) => (
            current === nextScrollMargin ? current : nextScrollMargin
        ));
    }, []);

    useLayoutEffect(() => {
        measureGrid();
        if (
            typeof window === 'undefined' ||
            typeof window.addEventListener !== 'function'
        ) return;

        window.addEventListener('resize', measureGrid);
        const node = rootRef.current;
        const resizeObserver = typeof ResizeObserver === 'undefined'
            ? null
            : new ResizeObserver(measureGrid);
        if (node) resizeObserver?.observe(node);

        return () => {
            window.removeEventListener('resize', measureGrid);
            resizeObserver?.disconnect();
        };
    }, [data.length, measureGrid]);

    const itemSize = useMemo(() => {
        const availableWidth = Math.max(
            containerWidth - GAP * (NUM_COLUMNS - 1) - H_PADDING * 2,
            NUM_COLUMNS,
        );
        return Math.max(1, Math.floor(availableWidth / NUM_COLUMNS));
    }, [containerWidth]);
    const rowCount = Math.ceil(data.length / NUM_COLUMNS);

    const virtualizer = useWindowVirtualizer<HTMLDivElement>({
        count: rowCount,
        estimateSize: () => itemSize + GAP,
        overscan: OVERSCAN_ROWS,
        scrollMargin,
        getItemKey: (rowIndex) => {
            const firstItem = data[rowIndex * NUM_COLUMNS];
            return firstItem
                ? `${firstItem.postId}:${firstItem.mediaIndex}`
                : `profile-grid-row:${rowIndex}`;
        },
    });
    const virtualRows = virtualizer.getVirtualItems();
    const totalSize = virtualizer.getTotalSize();
    const lastRow = virtualRows.at(-1);
    const lastRowEnd = lastRow
        ? lastRow.start + lastRow.size - virtualizer.options.scrollMargin
        : 0;
    const spacerHeight = Math.max(totalSize, lastRowEnd);

    if (data.length === 0) {
        return (
            <div ref={rootRef} className={containerClassName}>
                {listHeaderComponent}
                {listStickyHeaderComponent}
                {emptyComponent}
            </div>
        );
    }

    return (
        <div ref={rootRef} className={containerClassName}>
            {listHeaderComponent}
            {listStickyHeaderComponent}
            <div
                ref={gridRef}
                style={{
                    height: spacerHeight,
                    width: '100%',
                    position: 'relative',
                    paddingLeft: H_PADDING,
                    paddingRight: H_PADDING,
                }}
            >
                {virtualRows.map((virtualRow) => {
                    const startIndex = virtualRow.index * NUM_COLUMNS;
                    const rowItems = data.slice(
                        startIndex,
                        startIndex + NUM_COLUMNS,
                    );
                    return (
                        <div
                            key={virtualRow.key as React.Key}
                            data-index={virtualRow.index}
                            style={{
                                position: 'absolute',
                                top: 0,
                                left: H_PADDING,
                                display: 'grid',
                                gridTemplateColumns: `repeat(${NUM_COLUMNS}, ${itemSize}px)`,
                                columnGap: GAP,
                                width: '100%',
                                height: itemSize,
                                transform: `translateY(${virtualRow.start - virtualizer.options.scrollMargin}px)`,
                            }}
                        >
                            {rowItems.map((item, columnIndex) => (
                                <div
                                    key={`${item.postId}:${item.mediaIndex}:${columnIndex}`}
                                    style={{
                                        width: itemSize,
                                        height: itemSize,
                                    }}
                                >
                                    {renderCell(item, itemSize)}
                                </div>
                            ))}
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
