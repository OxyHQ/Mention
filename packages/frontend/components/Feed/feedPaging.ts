/**
 * Paging rules shared by every Feed. Pure and dependency-free, so tests can use
 * the real functions without loading the row renderer.
 */

/**
 * An embedded preview Feed (`previewLimit`) holds at most that many rows. The
 * embedded list is not virtualized, so this bound IS its mounted-row count.
 * Returns the input unchanged (same identity) when unbounded or within bound.
 */
export function boundFeedRows<T>(rows: T[], previewLimit: number | undefined): T[] {
  if (previewLimit === undefined || rows.length <= previewLimit) return rows;
  return rows.slice(0, Math.max(0, previewLimit));
}

/** Whether a feed may request its next page: never for a bounded preview. */
export function canLoadMoreFeed(state: {
  previewLimit?: number;
  hasMore: boolean;
  isLoading: boolean;
}): boolean {
  return state.previewLimit === undefined && state.hasMore && !state.isLoading;
}
