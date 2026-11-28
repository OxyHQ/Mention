/**
 * `j` / `k` on web: move focus to the next or previous post on screen.
 *
 * The feed marks every mounted post row with `data-post-uri`, and keeps the
 * neighbours of the visible ones mounted, so the DOM is the list to walk.
 */

/** Room the sticky header and tabs take above a post brought into view. */
export const POST_FOCUS_TOP_OFFSET = 112;

export interface RowPosition {
  top: number;
  bottom: number;
}

/**
 * The index to focus. `rows` are in reading order; with none focused yet, either
 * key starts at the first row still readable below the header.
 */
export function adjacentRow(
  rows: readonly RowPosition[],
  focused: number,
  direction: 1 | -1,
): number {
  if (rows.length === 0) return -1;
  if (focused >= 0) return Math.min(rows.length - 1, Math.max(0, focused + direction));
  const reading = rows.findIndex((row) => row.bottom > POST_FOCUS_TOP_OFFSET);
  return reading === -1 ? rows.length - 1 : reading;
}

export function focusAdjacentPost(direction: 1 | -1, root: Document = document): boolean {
  // A dialog owns the keyboard while it is open.
  if (root.querySelector('[aria-modal="true"]')) return false;
  const rows = Array.from(root.querySelectorAll<HTMLElement>('[data-post-uri]'))
    // A feed kept mounted behind another one draws no box, or sits in an inert tree.
    .filter(
      (row) => row.getClientRects().length > 0 && !row.closest('[inert],[aria-hidden="true"]'),
    )
    .map((element) => ({ element, rect: element.getBoundingClientRect() }))
    .sort((a, b) => a.rect.top - b.rect.top);
  const active = root.activeElement;
  const focused = rows.findIndex(({ element }) => element === active || element.contains(active));
  const target =
    rows[
      adjacentRow(
        rows.map(({ rect }) => rect),
        focused,
        direction,
      )
    ]?.element;
  if (!target) return false;
  target.setAttribute('tabindex', '-1');
  target.style.scrollMarginTop = `${POST_FOCUS_TOP_OFFSET}px`;
  target.focus({ preventScroll: true });
  target.scrollIntoView({ block: 'start' });
  return true;
}
