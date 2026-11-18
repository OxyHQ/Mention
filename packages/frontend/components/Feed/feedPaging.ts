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

/**
 * Whether reaching the end of the list requests the next page by itself.
 *
 * Not for a feed that loads on request (a minor's, oxy ADR 0068): there the
 * next page comes when the reader asks for it with the footer's button, so the
 * feed has an end to arrive at instead of scrolling on.
 */
export function canAutoLoadFeed(state: {
  previewLimit?: number;
  hasMore: boolean;
  isLoading: boolean;
  loadsOnRequest: boolean;
}): boolean {
  return !state.loadsOnRequest && canLoadMoreFeed(state);
}

/**
 * The home timelines, where reaching the end means "you have read what the
 * people you follow posted". Not a profile, a search or a hashtag: running out
 * of rows there says nothing about being up to date.
 */
const CAUGHT_UP_SOURCES: ReadonlySet<string> = new Set(['for_you', 'following', 'mutuals']);

/** Whether a feed's end is worth telling the reader about. */
export function showsCaughtUp(feedDescriptor: string): boolean {
  return CAUGHT_UP_SOURCES.has(feedDescriptor.split('|')[0]);
}

/** Whether a feed may request its next page: never for a bounded preview. */
export function canLoadMoreFeed(state: {
  previewLimit?: number;
  hasMore: boolean;
  isLoading: boolean;
}): boolean {
  return state.previewLimit === undefined && state.hasMore && !state.isLoading;
}
