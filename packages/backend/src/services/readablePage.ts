/**
 * Pagination that describes only what the viewer may read.
 *
 * A listing selects candidate rows in SQL and hydration then drops the ones the
 * viewer may not read (the read gate in `PostHydrationService`). A `hasMore` or a
 * cursor taken from the CANDIDATE rows describes rows the viewer was refused:
 * `limit=1` and an empty page with `hasMore: true` says a hidden post matches the
 * query, and a cursor anchored on a hidden row carries its id and creation time.
 * So a page is filled from readable rows, `hasMore` means a further READABLE row
 * was seen, and the cursor is taken from the last readable row returned.
 *
 * The scan is bounded ({@link DEFAULT_SCAN_BUDGET} candidate rows). Running out
 * of budget ends the listing (fewer entries than asked for, so no `hasMore`)
 * rather than reporting more on the strength of rows the viewer may not see.
 */

/** Candidate rows one request may examine before it stops looking. */
export const DEFAULT_SCAN_BUDGET = 200;

/** After the first chunk (sized to the request), how many rows each further read asks for. */
const FOLLOW_UP_CHUNK = 50;

export interface ReadableEntry<Row, Item> {
  /** The candidate row, for the caller's cursor. */
  row: Row;
  /** What hydration made of it. */
  item: Item;
}

export async function collectReadable<Row extends { id: string }, Item extends { id: string }>({
  want,
  fetchAfter,
  hydrate,
  scanBudget = DEFAULT_SCAN_BUDGET,
}: {
  /** How many readable entries to collect. */
  want: number;
  /** The next `size` candidates after `last` (the first page when `last` is undefined), in order. */
  fetchAfter: (last: Row | undefined, size: number) => Promise<Row[]>;
  /** The readable subset of `rows`, as hydration answers it. */
  hydrate: (rows: Row[]) => Promise<Item[]>;
  scanBudget?: number;
}): Promise<ReadableEntry<Row, Item>[]> {
  const entries: ReadableEntry<Row, Item>[] = [];
  let last: Row | undefined;
  let scanned = 0;
  while (entries.length < want) {
    const size = Math.min(
      scanned === 0 ? want : Math.max(want, FOLLOW_UP_CHUNK),
      scanBudget - scanned,
    );
    if (size <= 0) break;
    const rows = await fetchAfter(last, size);
    scanned += rows.length;
    const readable = new Map((await hydrate(rows)).map((item) => [item.id, item]));
    for (const row of rows) {
      const item = readable.get(row.id);
      if (item && entries.length < want) entries.push({ row, item });
    }
    if (rows.length < size) break;
    last = rows[rows.length - 1];
  }
  return entries;
}
