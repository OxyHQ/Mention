import { useLayoutEffect, useState, type RefObject } from 'react';

/**
 * The virtualizer's measurement origin: the wrapper's offset from the document
 * top (header + anything above the list), so virtual offsets map to page
 * offsets. The window is the scroller.
 *
 * Driven by the wrapper's own BOX, and a zero-sized box is never stored. Both
 * halves are load-bearing, and the reason is not obvious from the code that
 * replaced — so it is written down here rather than rediscovered.
 *
 * This used to be a `useLayoutEffect` keyed on the ROW COUNT, which was correct
 * only while a feed could not be mounted and hidden at the same time. A tab
 * navigator makes exactly that happen: the non-focused tab renders at
 * `display: none`, and a hidden wrapper measures `{top: 0, height: 0, width: 0}`.
 * Two failure modes followed, and closing either one alone is not enough:
 *
 *  - It RAN while box-less, so `top + window.scrollY` evaluated to the scroll
 *    position of whichever tab was VISIBLE and stored it as this feed's origin.
 *    Every row is then positioned against a number belonging to another screen.
 *  - It never re-ran on RETURN, because the row count does not change again —
 *    so a single poisoned measurement lasted the rest of the session. The
 *    ordinary causes all reached it: a background refresh, a socket update, the
 *    memory-mode new-post broadcast.
 *
 * A `ResizeObserver` closes both. It fires on the 0 -> real transition when the
 * element is shown again, and on any later layout change, so the origin is
 * re-derived whenever it could genuinely have moved — and it covers every cause
 * of the box appearing, not just a tab becoming visible. It also keeps the
 * router out of the feed: the box is the honest signal and it does not care WHY
 * the element became visible.
 *
 * It observes TWO targets, and the second is not redundant: the wrapper's TOP
 * can move without the wrapper itself resizing at all — a header or a media
 * embed ABOVE the list growing does it, which is the stale-origin case where
 * rows are positioned against a point that has since shifted. Observing only
 * the wrapper would be a regression against the old row-count key there, since
 * a row-count change at least correlated with content moving.
 */
export function useScrollMarginOrigin(ref: RefObject<HTMLElement | null>): number {
  const [scrollMargin, setScrollMargin] = useState(0);

  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return undefined;

    const measure = () => {
      const rect = node.getBoundingClientRect();
      // No box: the element is `display: none`, or not laid out yet. There is
      // nothing true to read, and reading anyway is the bug described above.
      if (rect.width === 0 && rect.height === 0) return;
      const top = rect.top + window.scrollY;
      setScrollMargin((prev) => (prev !== top ? top : prev));
    };

    measure();

    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    if (typeof document !== 'undefined' && document.body) {
      observer.observe(document.body);
    }
    return () => observer.disconnect();
  }, [ref]);

  return scrollMargin;
}
