import type React from 'react';
import { useCallback, useEffect, useMemo, useRef, memo } from 'react';
import { StyleSheet, View } from 'react-native';
import { useWindowVirtualizer } from '@tanstack/react-virtual';
import { useScrollRestoration } from '@oxy.so/bloom/scroll';
import { useRevealOwnNewPost } from '@/hooks/useRevealOwnNewPost';
import { getItemKey } from '@/utils/feedUtils';
import { renderFeedRow, feedRowKey } from './feedRows';
import { useScrollMarginOrigin } from './useScrollMarginOrigin';
import { recordBootMilestone } from '@/lib/webTelemetry';
import { type FeedProps, FeedErrorBoundary, areFeedPropsEqual, useFeedCore } from './useFeedCore';

// Estimated row height (px) before a row is measured. Post rows vary widely
// (text-only vs. media vs. threads), so this is only the first-paint guess;
// `measureElement` replaces it with the real height once each row mounts.
const ESTIMATED_ROW_HEIGHT = 140;

// Small overscan keeps the mounted-row count bounded (~viewport + a handful) so
// the DOM never holds the whole feed — the whole point of virtualizing on web.
const OVERSCAN_ROWS = 8;

// The load-more sentinel is observed `rootMargin` before it actually enters the
// viewport, so the next page is requested ahead of the reader reaching the end.
// Two viewports, not a fixed 600px (about one screen): a feed page runs the
// whole gather-rank-hydrate pipeline server-side, and at one screen of lead a
// steady scroll reached the spinner before the page arrived. Matches the
// native list's `onEndReachedThreshold={2}`.
const LOAD_MORE_ROOT_MARGIN = '200%';

// A feed row counts as "visible" for impression tracking once ≥50% of it is in
// the viewport. The tracker then requires ≥1s of visibility before reporting.
const IMPRESSION_VISIBILITY_THRESHOLD = 0.5;

// DOM attribute carrying a row's post id, read by the impression observer to map
// an intersecting row element back to its post. ONLY post rows carry it —
// a recommendation card has no post to report an impression for.
const POST_URI_ATTR = 'data-post-uri';

// Upper bound on each cached row-ref map. Only rows in the virtual window are
// ever mounted, so a modest cap comfortably covers the live set; evicting the
// rest just means a future re-scroll recreates that row's callback once.
const ROW_REF_CACHE_LIMIT = 500;

/**
 * EMBEDDED web feed (scrollEnabled === false): a non-virtualized plain list that
 * composes inside a PARENT scroller. Window-virtualizing here would be WRONG —
 * `useWindowVirtualizer` measures and paginates against the document (`window`)
 * scroll, but an embedded feed's scroll happens in its parent (an inner
 * `overflow:auto` container on web), so the window virtualizer would mount only
 * the first viewport and never paginate. Mirrors native's embedded FlashList
 * mode (`scrollEnabled={false}` → renderScrollComponent).
 *
 * After the feed unification NO web screen currently passes `scrollEnabled=false`
 * (the profile screen, `lists/[id]` posts, and `feeds/[id]` recent all now own
 * the document scroll via the virtualized path). This component is retained
 * deliberately so the shared `Feed` `scrollEnabled` contract is honored
 * symmetrically on web and native: native's embedded mode is still used (e.g.
 * `ProfileTabs` on native), and a web caller that opts into `scrollEnabled=false`
 * must compose correctly rather than silently window-virtualize inside a parent
 * scroller. Prefer the virtualized document-scroll path; only reach for this when
 * a genuine inner-scroll parent makes document scroll impossible.
 */
function EmbeddedWebFeed(props: FeedProps) {
  const core = useFeedCore(props);
  const { props: merged, theme, router, feedRows, feedDescriptor } = core;

  return (
    <View style={[{ minHeight: 0 }, merged.style]}>
      {core.header}
      {merged.listContentHeaderComponent}
      {merged.listStickyHeaderComponent}
      {core.leading}
      {feedRows.length === 0 ? (
        core.emptyState
      ) : (
        <View style={merged.contentContainerStyle}>
          {feedRows.map((row) => (
            <View key={feedRowKey(row)}>
              {renderFeedRow(row, { router, threadLineColor: theme.colors.border, feedDescriptor })}
            </View>
          ))}
        </View>
      )}
      {core.footer}
    </View>
  );
}

/**
 * SCROLL-OWNING web feed (scrollEnabled !== false): virtualized against the
 * DOCUMENT scroller via `useWindowVirtualizer`. The body scrolls (so scrolling
 * works from anywhere, including over the sticky side columns); only the rows in
 * the virtual window are mounted, so the DOM stays bounded. This is the PRIMARY
 * web feed render path — embedded (non-scroll-owning) feeds compose by passing
 * their page header/tab bar as `listHeaderComponent`, so the document scroll
 * still owns the one virtualized list (mirrors native's `ListHeaderComponent`).
 */
function scrollWindowToTop(): void {
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function VirtualizedWebFeed(props: FeedProps) {
  // DECLARED, not inherited. The long note at `getVirtualItems()` below explains
  // why this component must not be memoized; until now the only thing enforcing
  // that was two incidental ref-`.current` reads during render, i.e. the
  // compiler refusing the function for an unrelated reason. That is a guarantee
  // nobody can see from the render path, and any tidy-up of those reads — the
  // kind of change that looks purely cosmetic — silently reintroduces a
  // production-only frozen feed on the most-used screen in the app.
  //
  // `ProfileGridList.web.tsx` and `SavedPostsList.web.tsx` already state it this
  // way. The ref reads stay exactly as they are; this only makes the intent
  // load-bearing instead of accidental.
  'use no memo';

  const core = useFeedCore(props);
  const {
    props: merged,
    theme,
    router,
    feedState,
    feedRows,
    handleLoadMore,
    feedDescriptor,
    impressionTracker,
    receivesOwnNewPost,
  } = core;

  // Wrapper element used as the virtualizer's measurement origin. The window is
  // the scroller; `scrollMargin` is the wrapper's offset from the document top
  // (header + anything above the list), so virtual offsets map to page offsets.
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  // The virtualizer's measurement origin. Box-driven, never stored while the
  // wrapper is collapsed — see the hook for why the old row-count key was
  // wrong once a feed can be mounted and hidden at once.
  const scrollMargin = useScrollMarginOrigin(wrapperRef);

  // `contentContainerStyle` (a caller-provided RN style, e.g. paddingBottom) is
  // flattened to a CSS object for the DOM wrapper. It sits OUTSIDE the measured
  // spacer so the virtual math stays exact.
  const contentContainerCss = useMemo(
    () => StyleSheet.flatten(merged.contentContainerStyle) as React.CSSProperties | undefined,
    [merged.contentContainerStyle],
  );

  const count = feedRows.length;

  const virtualizer = useWindowVirtualizer<HTMLDivElement>({
    count,
    estimateSize: () => ESTIMATED_ROW_HEIGHT,
    overscan: OVERSCAN_ROWS,
    scrollMargin,
    getItemKey: (index) => feedRowKey(feedRows[index]),
  });

  // THE REACT COMPILER MUST NOT MEMOIZE THIS COMPONENT — and today it doesn't,
  // by accident. `virtualizer` has a STABLE identity for this component's
  // lifetime and forces re-renders through a reducer INTERNAL to
  // `useWindowVirtualizer`, so a scroll changes nothing this function can see.
  // If the compiler memoizes the render, both reads below and the row JSX get
  // cached on deps that never change and the feed freezes on its first window
  // — no error, virtualizer healthy, DOM stuck. What prevents that is two
  // ref-`.current` reads during render, each of which makes the compiler
  // refuse this whole function (verified: it emits no memo cache at all):
  //   1. `loadMoreRef.current = handleLoadMore` below
  //   2. `getPostRowRef`/`getMeasureRef` read their caches inside the row map
  // Removing BOTH makes this compile to a 64-slot cache and reintroduces the
  // freeze. Judge that by the compiler's own CompileError/CompileSuccess
  // events, not by grepping the output for a cache call — this comment would
  // match such a grep.
  // This is not hypothetical: `ProfileGridList.web.tsx` has the same shape,
  // compiles, and shipped frozen — it now carries an explicit `'use no memo'`.
  // Do not reason about which of these is "safe" structurally; the compiler's
  // grouping is per-file and a captured ref does NOT reliably prevent it
  // (measured both ways). If you change this render path, re-verify by
  // compiling this file with the app's own babel-plugin-react-compiler and
  // confirming `getVirtualItems()` is still called unguarded.
  const virtualItems = virtualizer.getVirtualItems();
  const totalSize = virtualizer.getTotalSize();

  // The measured spacer height MUST contain every absolutely-positioned row,
  // otherwise the rows overflow it. Because the rows are `position: absolute`,
  // an overflow does NOT grow the spacer — so the feed column (and the flex row
  // that is the side rails' sticky containing block) stays at its pre-overflow
  // height while the document grows past it. Once the user scrolls beyond that
  // stale height the sticky rails hit the bottom of their containing block and
  // scroll away. This happens whenever the rows' real extent diverges from
  // `getTotalSize()` — e.g. `scrollMargin` is momentarily stale after content
  // above the window grows (async media load) so `virtualRow.start` (computed
  // against the new measurements) and `getTotalSize()` disagree. Sizing the
  // spacer to the MAX of `totalSize` and the rows' real extent (in spacer
  // space) guarantees the spacer always contains its rows, so the feed column
  // — and the rails' containing block — always grows to the full content
  // height and the rails stay pinned.
  const lastItem = virtualItems.length > 0 ? virtualItems[virtualItems.length - 1] : undefined;
  const lastItemEnd = lastItem
    ? lastItem.start + lastItem.size - virtualizer.options.scrollMargin
    : 0;
  const spacerHeight = Math.max(totalSize, lastItemEnd);

  // Infinite pagination via an IntersectionObserver on a 1px sentinel at the
  // END of the measured spacer, observed against the DOCUMENT viewport
  // (root: null). The previous trigger compared the last MOUNTED virtual row
  // index to `count`, which STALLS in production: when no row has measured yet
  // `getTotalSize()` is 0 and `getVirtualItems()` can return an empty set, so
  // `lastVirtualIndex` never advances and the next page is never requested. The
  // sentinel is a real DOM node, so the observer fires purely on geometry —
  // independent of the virtualizer's measurement state — and re-fires for each
  // new page as the (re-positioned) sentinel re-enters the rootMargin band.
  // `handleLoadMore` is guarded (hasMore / isLoading) and debounced in the
  // hook, so repeated intersections are safe. Subscribing to a browser observer
  // is a legitimate effect (an external event source), not derived state. The
  // live `handleLoadMore` is read through a ref so the observer is rebuilt only
  // when the data-end gate (`count`/`hasMore`) actually changes.
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const loadMoreRef = useRef(handleLoadMore);
  loadMoreRef.current = handleLoadMore;
  const hasMore = feedState.hasMore;
  useEffect(() => {
    const node = sentinelRef.current;
    if (!node || count === 0 || !hasMore) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          loadMoreRef.current();
        }
      },
      { root: null, rootMargin: LOAD_MORE_ROOT_MARGIN },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [count, hasMore]);

  // Per-row impression observer. A single IntersectionObserver (threshold 50%)
  // watches every mounted row; crossing the threshold marks the row's post
  // visible/hidden on the tracker, which gates the ≥1s dwell requirement and
  // batches the network writes. The tracker is read through a ref so the
  // observer is built ONCE and never rebuilt as rows/data change. Subscribing
  // to a browser observer is a legitimate effect (an external event source).
  const trackerRef = impressionTracker;
  const impressionObserverRef = useRef<IntersectionObserver | null>(null);
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        const tracker = trackerRef.current;
        if (!tracker) return;
        for (const entry of entries) {
          const postUri = entry.target.getAttribute(POST_URI_ATTR);
          if (!postUri) continue;
          if (entry.isIntersecting && entry.intersectionRatio >= IMPRESSION_VISIBILITY_THRESHOLD) {
            tracker.setVisible(postUri);
          } else {
            tracker.setHidden(postUri);
          }
        }
      },
      { root: null, threshold: [0, IMPRESSION_VISIBILITY_THRESHOLD, 1] },
    );
    impressionObserverRef.current = observer;
    return () => {
      observer.disconnect();
      impressionObserverRef.current = null;
    };
    // trackerRef is a stable ref object; the observer reads `.current` live.
  }, [trackerRef]);

  // Per-row ref factories. Both return a STABLE callback (cached per row) —
  // stability matters, because a fresh inline arrow each render would make React
  // detach/re-attach every ref on every render, re-measuring rows and thrashing
  // observation. The cached callback is reused across renders for the same row,
  // so the ref only fires on real mount/unmount. `measureElement` is stable for
  // the lifetime of this virtualizer.
  //
  // A recommendation card gets MEASUREMENT ONLY: it must never carry a
  // `data-post-uri`, never enter the impression observer, and therefore never
  // send a bogus `postUri` to `POST /feed/mtn/interactions`.
  const measureElement = virtualizer.measureElement;

  const measureRefCallbacks = useRef(new Map<string, (node: HTMLDivElement | null) => void>());
  const getMeasureRef = useCallback(
    (rowKey: string) => {
      const cache = measureRefCallbacks.current;
      const existing = cache.get(rowKey);
      if (existing) return existing;
      if (cache.size > ROW_REF_CACHE_LIMIT) cache.clear();
      // Virtualizer measurement only (reads data-index → getBoundingClientRect).
      const cb = (node: HTMLDivElement | null) => measureElement(node);
      cache.set(rowKey, cb);
      return cb;
    },
    [measureElement],
  );

  // Post rows: measurement + impression observation on the SAME node, so
  // impression ratios reflect the real row geometry.
  const postRowRefCallbacks = useRef(new Map<string, (node: HTMLDivElement | null) => void>());
  const getPostRowRef = useCallback(
    (postUri: string) => {
      const cache = postRowRefCallbacks.current;
      const existing = cache.get(postUri);
      if (existing) return existing;
      if (cache.size > ROW_REF_CACHE_LIMIT) cache.clear();
      const cb = (node: HTMLDivElement | null) => {
        measureElement(node);
        if (node) {
          node.setAttribute(POST_URI_ATTR, postUri);
          impressionObserverRef.current?.observe(node);
          // First time any feed puts a post in the document.
          recordBootMilestone('content-ready');
        }
        // No explicit unobserve: when a virtual row unmounts React calls this
        // with null AFTER the node is gone; the observer drops detached nodes
        // and is fully disconnected on feed unmount. A row leaving the viewport
        // first fires an un-intersect (→ setHidden) before it unmounts.
      };
      cache.set(postUri, cb);
      return cb;
    },
    [measureElement],
  );

  // The route alone is not enough: Explore/profile tabs can host distinct
  // feeds under one navigation entry. Scope the offset to the same stable
  // viewer/feed identity that owns the retained page cache.
  const { restorePending } = useScrollRestoration('window', {
    enabled: true,
    key: feedState.feedScrollKey,
  });

  // Back from the composer, the route's saved offset is restored — which left
  // the reader's own new post, inserted at the head of the list, above the
  // fold. Bring it into view once, AFTER that restore has landed, or the
  // restore would move the page straight back.
  useRevealOwnNewPost({
    feedKey: feedState.feedScrollKey,
    enabled: !restorePending && count > 0 && receivesOwnNewPost,
    scrollToTop: scrollWindowToTop,
  });

  return (
    <FeedErrorBoundary>
      <View style={merged.style}>
        {core.header}
        {merged.listContentHeaderComponent}
        {merged.listStickyHeaderComponent}
        {core.leading}

        {count === 0 ? (
          core.emptyState
        ) : (
          // Web-only file: the virtual rows are plain DOM nodes so
          // react-virtual's `measureElement` (which reads `data-index`
          // and calls `getBoundingClientRect`) and the `ref` work
          // directly, without RN-web host-ref gymnastics. The row's
          // content is still the shared RN renderer (RNW → DOM).
          // `contentContainerStyle` wraps the measured container so
          // padding lives OUTSIDE the spacer (the spacer is exactly the
          // virtual height, and `scrollMargin` reads the spacer's top).
          <div style={contentContainerCss}>
            <div
              ref={wrapperRef}
              style={{ height: spacerHeight, width: '100%', position: 'relative' }}
            >
              {virtualItems.map((virtualRow) => {
                const row = feedRows[virtualRow.index];
                return (
                  <div
                    key={virtualRow.key as React.Key}
                    ref={
                      row.kind === 'post'
                        ? getPostRowRef(getItemKey(row.item))
                        : getMeasureRef(feedRowKey(row))
                    }
                    data-index={virtualRow.index}
                    style={{
                      position: 'absolute',
                      top: 0,
                      left: 0,
                      width: '100%',
                      transform: `translateY(${virtualRow.start - virtualizer.options.scrollMargin}px)`,
                    }}
                  >
                    {renderFeedRow(row, {
                      router,
                      threadLineColor: theme.colors.border,
                      feedDescriptor,
                    })}
                  </div>
                );
              })}
              {/* Load-more sentinel: a 1px probe pinned to the END of
                                the spacer. Observed against the document viewport
                                with a forward rootMargin so the next page loads just
                                before the user reaches the bottom. */}
              <div
                ref={sentinelRef}
                aria-hidden
                style={{ position: 'absolute', bottom: 0, left: 0, width: '100%', height: 1 }}
              />
            </div>
          </div>
        )}

        {core.footer}
      </View>
    </FeedErrorBoundary>
  );
}

const Feed = (props: FeedProps) => {
  // Embedded feeds compose inside a parent scroller, so they must NOT
  // window-virtualize (that would track document scroll, not the parent).
  if (props.scrollEnabled === false) {
    return <EmbeddedWebFeed {...props} />;
  }
  return <VirtualizedWebFeed {...props} />;
};

const MemoizedFeed = memo(Feed, areFeedPropsEqual);
MemoizedFeed.displayName = 'Feed';
export default MemoizedFeed;
