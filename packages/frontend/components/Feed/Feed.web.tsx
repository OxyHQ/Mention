import { usePanelScrollContainer } from '@oxy.so/bloom/app-shell/hooks';
import { VirtualList, type VirtualListHandle } from '@oxy.so/bloom/list';
import { useCallback, useRef, memo } from 'react';
import { View } from 'react-native';
import { useScrollRestoration } from '@oxy.so/bloom/scroll';
import { useRevealOwnNewPost } from '@/hooks/useRevealOwnNewPost';
import { getItemKey } from '@/utils/feedUtils';
import { renderFeedRow, feedRowKey, type FeedRow } from './feedRows';
import { recordBootMilestone } from '@/lib/webTelemetry';
import { type FeedProps, FeedErrorBoundary, areFeedPropsEqual, useFeedCore } from './useFeedCore';

// Estimated row height (px) before a row is measured. Post rows vary widely
// (text-only vs. media vs. threads), so this is only the first-paint guess; the
// list replaces it with the real height once each row mounts. Near a typical
// post with media rather than a one-line text post: an estimate far below the
// real heights mounts two or three times the rows the first paint can show.
const ESTIMATED_ROW_HEIGHT = 400;

// Small overscan keeps the mounted-row count bounded (~viewport + a handful) so
// the DOM never holds the whole feed — the whole point of virtualizing on web.
// Rows are tall, so three on each side is already a screen or more.
const OVERSCAN_ROWS = 3;

// The next page is requested two viewports before the reader reaches the end: a
// feed page runs the whole gather-rank-hydrate pipeline server-side, and at one
// screen of lead a steady scroll reached the spinner before the page arrived.
// Matches the native list's `onEndReachedThreshold={2}`.
const LOAD_MORE_THRESHOLD = 2;

// A feed row counts as "visible" for impression tracking once ≥50% of it is in
// the viewport. The tracker then requires ≥1s of visibility before reporting.
const IMPRESSION_VISIBILITY_THRESHOLD = 0.5;

// DOM attribute carrying a row's post id, read by the impression observer to map
// an intersecting row element back to its post. ONLY post rows carry it —
// a recommendation card has no post to report an impression for.
const POST_URI_ATTR = 'data-post-uri';

/**
 * EMBEDDED web feed (scrollEnabled === false): a non-virtualized plain list that
 * composes inside a PARENT scroller. Virtualizing here would be WRONG — the
 * virtualized list measures and paginates against the Screen's scroller, but an
 * embedded feed's scroll happens in its parent (an inner `overflow:auto`
 * container on web), so it would mount only the first viewport and never
 * paginate. Mirrors native's embedded FlashList
 * mode (`scrollEnabled={false}` → renderScrollComponent).
 *
 * After the feed unification NO web screen currently passes `scrollEnabled=false`
 * (the profile screen, `lists/[id]` posts, and `feeds/[id]` recent all now own
 * the document scroll via the virtualized path). This component is retained
 * deliberately so the shared `Feed` `scrollEnabled` contract is honored
 * symmetrically on web and native: native's embedded mode is still used (e.g.
 * `ProfileTabs` on native), and a web caller that opts into `scrollEnabled=false`
 * must compose correctly rather than silently virtualize inside a parent
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
 * SCROLL-OWNING web feed (scrollEnabled !== false): Bloom's `VirtualList`, which
 * windows against whatever the Screen in front scrolls (the document, or an
 * element-kind panel) and creates no scroll container of its own. Only the rows
 * in the virtual window are mounted, so the DOM stays bounded. This is the
 * PRIMARY web feed render path — embedded (non-scroll-owning) feeds compose by
 * passing their page header/tab bar as `listHeaderComponent`, so the screen's
 * scroller still owns the one virtualized list (mirrors native's
 * `ListHeaderComponent`).
 */
function VirtualizedWebFeed(props: FeedProps) {
  const panel = usePanelScrollContainer<HTMLElement>();
  const listRef = useRef<VirtualListHandle>(null);
  const scrollToTop = useCallback(() => listRef.current?.scrollToOffset({ offset: 0 }), []);

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

  // Per-row impression observer. ONE IntersectionObserver (threshold 50%) watches
  // every mounted post row against the viewport (the implicit root clips through
  // a panel's own scroller too); crossing the threshold marks the row's post
  // visible/hidden on the tracker, which gates the ≥1s dwell requirement and
  // batches the network writes. Created by the first row that mounts, read
  // through a ref so it is never rebuilt as rows/data change.
  const impressionObserverRef = useRef<IntersectionObserver | null>(null);
  const observeImpressions = useCallback(
    (node: HTMLDivElement | null) => {
      if (!node) return;
      impressionObserverRef.current ??= new IntersectionObserver(
        (entries) => {
          const tracker = impressionTracker.current;
          for (const entry of entries) {
            const postUri = entry.target.getAttribute(POST_URI_ATTR);
            if (!postUri) continue;
            if (
              entry.isIntersecting &&
              entry.intersectionRatio >= IMPRESSION_VISIBILITY_THRESHOLD
            ) {
              tracker.setVisible(postUri);
            } else {
              tracker.setHidden(postUri);
            }
          }
        },
        { threshold: [0, IMPRESSION_VISIBILITY_THRESHOLD, 1] },
      );
      const observer = impressionObserverRef.current;
      observer.observe(node);
      // First time any feed puts a post in the document.
      recordBootMilestone('content-ready');
      return () => {
        observer.unobserve(node);
        // A row can unmount while still on screen (a refresh replaces the page);
        // an unobserved node reports nothing more, so close its dwell here.
        const postUri = node.getAttribute(POST_URI_ATTR);
        if (postUri) impressionTracker.current.setHidden(postUri);
      };
    },
    [impressionTracker],
  );

  const renderRow = useCallback(
    ({ item: row }: { item: FeedRow }) => {
      const content = renderFeedRow(row, {
        router,
        threadLineColor: theme.colors.border,
        feedDescriptor,
      });
      // Recommendation cards never carry a post URI or enter impression tracking.
      if (row.kind !== 'post') return content;
      return (
        <div ref={observeImpressions} data-post-uri={getItemKey(row.item)}>
          {content}
        </div>
      );
    },
    [router, theme.colors.border, feedDescriptor, observeImpressions],
  );

  // The route alone is not enough: Explore/profile tabs can host distinct
  // feeds under one navigation entry. Scope the offset to the same stable
  // viewer/feed identity that owns the retained page cache.
  const { restorePending } = useScrollRestoration('window', {
    enabled: !panel,
    key: feedState.feedScrollKey,
  });

  // Back from the composer, the route's saved offset is restored — which left
  // the reader's own new post, inserted at the head of the list, above the
  // fold. Bring it into view once, AFTER that restore has landed, or the
  // restore would move the page straight back.
  useRevealOwnNewPost({
    feedKey: feedState.feedScrollKey,
    enabled: !restorePending && feedRows.length > 0 && receivesOwnNewPost,
    scrollToTop,
  });

  return (
    <FeedErrorBoundary>
      <VirtualList
        ref={listRef}
        restorationKey={feedState.feedScrollKey}
        data={feedRows}
        keyExtractor={feedRowKey}
        renderItem={renderRow}
        estimatedItemSize={ESTIMATED_ROW_HEIGHT}
        overscan={OVERSCAN_ROWS}
        onEndReached={handleLoadMore}
        onEndReachedThreshold={LOAD_MORE_THRESHOLD}
        style={merged.style}
        contentContainerStyle={merged.contentContainerStyle}
        ListHeaderComponent={
          <>
            {core.header}
            {merged.listContentHeaderComponent}
            {merged.listStickyHeaderComponent}
            {core.leading}
          </>
        }
        ListEmptyComponent={core.emptyState}
        ListFooterComponent={core.footer}
      />
    </FeedErrorBoundary>
  );
}

const Feed = (props: FeedProps) => {
  // Embedded feeds compose inside a parent scroller, so they must NOT
  // virtualize (that would track the screen's scroller, not the parent).
  if (props.scrollEnabled === false) {
    return <EmbeddedWebFeed {...props} />;
  }
  return <VirtualizedWebFeed {...props} />;
};

const MemoizedFeed = memo(Feed, areFeedPropsEqual);
MemoizedFeed.displayName = 'Feed';
export default MemoizedFeed;
