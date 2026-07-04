import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, memo } from 'react';
import { StyleSheet, View } from 'react-native';
import { useWindowVirtualizer } from '@tanstack/react-virtual';
import { FeedType } from '@mention/shared-types';
import { ErrorBoundary } from '@oxyhq/bloom/error-boundary';
import { useAuth } from '@oxyhq/services';
import { useTheme } from '@oxyhq/bloom/theme';
import { useRouter } from 'expo-router';
import { useScrollRestoration } from '@oxyhq/bloom/scroll';
import { useTranslation } from 'react-i18next';
import { createScopedLogger } from '@/lib/logger';
import { useFeedState } from '@/hooks/useFeedState';
import { useDeepCompareMemo } from '@/hooks/useDeepCompare';
import { FeedFilters, shallowFiltersEqual } from '@/utils/feedUtils';
import { FeedHeader } from './FeedHeader';
import { FeedFooter } from './FeedFooter';
import { FeedEmptyState } from './FeedEmptyState';
import { usePrivacyControls } from '@/hooks/usePrivacyControls';
import { resolveFeedDescriptor, useFeedImpressionTracker } from '@/utils/feedTelemetry';
import { getItemKey } from '@/utils/feedUtils';
import {
    type FeedRow,
    buildFeedRows,
    renderFeedRow,
    feedRowKey,
} from './feedRows';

const logger = createScopedLogger('Feed');

interface FeedProps {
    type: FeedType;
    userId?: string;
    showComposeButton?: boolean;
    onComposePress?: () => void;
    hideHeader?: boolean;
    hideRefreshControl?: boolean;
    scrollEnabled?: boolean;
    showOnlySaved?: boolean;
    filters?: FeedFilters;
    reloadKey?: string | number;
    style?: React.ComponentProps<typeof View>['style'];
    contentContainerStyle?: React.ComponentProps<typeof View>['style'];
    listHeaderComponent?: React.ReactElement | null;
    threaded?: boolean;
    threadPostId?: string;
}

const DEFAULT_FEED_PROPS = {
    showComposeButton: false,
    hideHeader: false,
    hideRefreshControl: false,
    scrollEnabled: true,
    showOnlySaved: false,
} as const;

// Estimated row height (px) before a row is measured. Post rows vary widely
// (text-only vs. media vs. threads), so this is only the first-paint guess;
// `measureElement` replaces it with the real height once each row mounts.
const ESTIMATED_ROW_HEIGHT = 140;

// Small overscan keeps the mounted-row count bounded (~viewport + a handful) so
// the DOM never holds the whole feed — the whole point of virtualizing on web.
const OVERSCAN_ROWS = 8;

// The load-more sentinel is observed `rootMargin` px before it actually enters
// the viewport, so the next page is requested slightly ahead of the user
// hitting the literal end of the document (smoother infinite scroll).
const LOAD_MORE_ROOT_MARGIN = '600px';

// A feed row counts as "visible" for impression tracking once ≥50% of it is in
// the viewport. The tracker then requires ≥1s of visibility before reporting.
const IMPRESSION_VISIBILITY_THRESHOLD = 0.5;

// DOM attribute carrying a row's post id, read by the impression observer to map
// an intersecting row element back to its post.
const POST_URI_ATTR = 'data-post-uri';

/**
 * Shared data wiring for the web feed. Returns the live row set plus the
 * load-more / retry handlers.
 */
function useWebFeed(props: Required<Pick<FeedProps, 'type' | 'showOnlySaved'>> & FeedProps) {
    const {
        type,
        userId,
        showOnlySaved,
        filters,
        reloadKey,
        threaded,
        threadPostId,
    } = props;

    const useScoped = !!(filters && Object.keys(filters).length) && !showOnlySaved;
    const { user: currentUser, isAuthenticated, canUsePrivateApi } = useAuth();
    const { blockedSet } = usePrivacyControls();

    const feedState = useFeedState({
        type,
        userId,
        showOnlySaved,
        filters,
        useScoped,
        reloadKey,
        isAuthenticated,
        currentUserId: currentUser?.id,
    });

    const { refresh: feedRefresh, loadMore: feedLoadMore, clearError: feedClearError, fetchInitial: feedFetchInitial } = feedState;

    const feedRows = useDeepCompareMemo((): FeedRow[] => buildFeedRows({
        slices: feedState.slices,
        items: feedState.items,
        type,
        showOnlySaved,
        currentUserId: currentUser?.id,
        blockedSet,
        threaded,
        threadPostId,
    }), [feedState.slices, feedState.items, type, showOnlySaved, currentUser?.id, blockedSet, threaded, threadPostId]);

    // Infinite scroll for EVERYONE, anonymous included — public browse must keep
    // paginating as you scroll. The ONLY web-specific divergence from native is
    // that an anonymous viewer is never auto-prompted to sign in here: `signIn()`
    // opens the SDK sign-in modal, so an eager `signIn()` would hijack public
    // browse by popping the modal unprompted. The passive "Sign in to see more"
    // footer (rendered via `showFooter` below) is the ONLY sign-in affordance and
    // fires `signIn()` exclusively on user tap.
    // Pagination itself runs for anon and authed alike (gated only by
    // `hasMore`/`isLoading`, debounced inside the hook).
    const handleLoadMore = useCallback(() => {
        if (!feedState.hasMore || feedState.isLoading) return;
        feedLoadMore();
    }, [feedState.hasMore, feedState.isLoading, feedLoadMore]);

    const handleRetry = useCallback(async () => {
        feedClearError();
        try {
            await feedFetchInitial(true);
        } catch (retryError) {
            logger.error('Retry failed', { error: retryError });
        }
    }, [feedClearError, feedFetchInitial]);

    // Web has no RefreshControl, but the refresh path must stay reachable (e.g.
    // the home-refresh signal / tab re-press). A swallowed failure here would
    // otherwise surface as an unhandled rejection.
    const handleRefresh = useCallback(async () => {
        try {
            await feedRefresh();
        } catch (err) {
            logger.error('Error refreshing feed', { error: err });
        }
    }, [feedRefresh]);

    return {
        feedRows,
        feedState,
        isAuthenticated,
        // Feed-ranking telemetry may only POST for a viewer whose private API is
        // usable — an anonymous (or still-resolving) viewer would 401 the
        // `/feed/mtn/interactions` write in a loop. Gate reporting on this.
        canReport: canUsePrivateApi,
        currentUserId: currentUser?.id,
        handleLoadMore,
        handleRetry,
        handleRefresh,
    };
}

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
    const merged = { ...DEFAULT_FEED_PROPS, ...props };
    const { hideHeader, showComposeButton, onComposePress, listHeaderComponent, type, showOnlySaved } = merged;
    const theme = useTheme();
    const router = useRouter();
    const { feedRows, feedState, handleRetry } = useWebFeed(merged);

    const header = listHeaderComponent ?? (
        <FeedHeader showComposeButton={showComposeButton} onComposePress={onComposePress} hideHeader={hideHeader} />
    );

    return (
        <View className="bg-background" style={[{ minHeight: 0 }, merged.style]}>
            {header}
            {feedRows.length === 0 ? (
                <FeedEmptyState
                    isLoading={feedState.isLoading}
                    error={feedState.error}
                    hasItems={false}
                    type={type}
                    showOnlySaved={showOnlySaved}
                    onRetry={handleRetry}
                    pending={feedState.pending}
                />
            ) : (
                <View style={merged.contentContainerStyle}>
                    {feedRows.map((row) => (
                        <View key={feedRowKey(row)}>
                            {renderFeedRow(row, { router, threadLineColor: theme.colors.border })}
                        </View>
                    ))}
                </View>
            )}
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
function VirtualizedWebFeed(props: FeedProps) {
    const merged = { ...DEFAULT_FEED_PROPS, ...props };
    const { hideHeader, showComposeButton, onComposePress, listHeaderComponent, type, showOnlySaved, userId, filters, reloadKey } = merged;
    const { t } = useTranslation();
    const theme = useTheme();
    const router = useRouter();

    const {
        feedRows,
        feedState,
        isAuthenticated,
        canReport,
        handleLoadMore,
        handleRetry,
    } = useWebFeed(merged);

    // Feed-ranking telemetry: derive the descriptor this feed reports against and
    // own an impression tracker for the session. The session resets when the
    // descriptor changes or the feed is reloaded (reloadKey), so impressions are
    // counted once per post per session. `canReport` short-circuits reporting for
    // anonymous viewers so a public browse never POSTs (and never 401-loops).
    const feedDescriptor = resolveFeedDescriptor(type, userId, filters, showOnlySaved);
    const impressionTracker = useFeedImpressionTracker(feedDescriptor, reloadKey, canReport);

    // Wrapper element used as the virtualizer's measurement origin. The window is
    // the scroller; `scrollMargin` is the wrapper's offset from the document top
    // (header + anything above the list), so virtual offsets map to page offsets.
    const wrapperRef = useRef<HTMLDivElement | null>(null);
    const [scrollMargin, setScrollMargin] = useState(0);

    // `contentContainerStyle` (a caller-provided RN style, e.g. paddingBottom) is
    // flattened to a CSS object for the DOM wrapper. It sits OUTSIDE the measured
    // spacer so the virtual math stays exact.
    const contentContainerCss = useMemo(
        () => StyleSheet.flatten(merged.contentContainerStyle) as React.CSSProperties | undefined,
        [merged.contentContainerStyle]
    );

    // Read the wrapper's top offset synchronously after layout so the first
    // virtual frame already positions rows correctly (no visible jump). This is
    // a DOM measurement subscription, not a data effect.
    useLayoutEffect(() => {
        const node = wrapperRef.current;
        if (!node) return;
        const top = node.getBoundingClientRect().top + window.scrollY;
        setScrollMargin((prev) => (prev !== top ? top : prev));
    }, [feedRows.length]);

    const count = feedRows.length;

    const virtualizer = useWindowVirtualizer<HTMLDivElement>({
        count,
        estimateSize: () => ESTIMATED_ROW_HEIGHT,
        overscan: OVERSCAN_ROWS,
        scrollMargin,
        getItemKey: (index) => feedRowKey(feedRows[index]),
    });

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
    const lastItemEnd = lastItem ? lastItem.start + lastItem.size - virtualizer.options.scrollMargin : 0;
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
            { root: null, rootMargin: LOAD_MORE_ROOT_MARGIN }
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
            { root: null, threshold: [0, IMPRESSION_VISIBILITY_THRESHOLD, 1] }
        );
        impressionObserverRef.current = observer;
        return () => {
            observer.disconnect();
            impressionObserverRef.current = null;
        };
        // trackerRef is a stable ref object; the observer reads `.current` live.
    }, [trackerRef]);

    // Combined per-row ref factory: returns a STABLE callback (cached per post id)
    // that wires BOTH the virtualizer's measurement ref and the impression
    // observer on the same row node. Stability matters — a fresh inline arrow
    // each render would make React detach/re-attach every ref on every render,
    // re-measuring rows and thrashing observation. The cached callback is reused
    // across renders for the same post, so the ref only fires on real mount/
    // unmount. `measureElement` is stable for the lifetime of this virtualizer.
    const measureElement = virtualizer.measureElement;
    const rowRefCallbacks = useRef(new Map<string, (node: HTMLDivElement | null) => void>());
    const getRowRef = useCallback((postUri: string) => {
        const cache = rowRefCallbacks.current;
        const existing = cache.get(postUri);
        if (existing) return existing;
        // Bound the cache so a very long scroll session doesn't accumulate one
        // closure per post id forever. Only rows in the virtual window are ever
        // mounted, so a modest cap comfortably covers the live set; evicting the
        // rest just means a future re-scroll recreates that row's callback once.
        if (cache.size > 500) cache.clear();
        const cb = (node: HTMLDivElement | null) => {
            // Virtualizer measurement (reads data-index → getBoundingClientRect).
            measureElement(node);
            if (node) {
                node.setAttribute(POST_URI_ATTR, postUri);
                impressionObserverRef.current?.observe(node);
            }
            // No explicit unobserve: when a virtual row unmounts React calls this
            // with null AFTER the node is gone; the observer drops detached nodes
            // and is fully disconnected on feed unmount. A row leaving the viewport
            // first fires an un-intersect (→ setHidden) before it unmounts.
        };
        cache.set(postUri, cb);
        return cb;
    }, [measureElement]);

    // Scroll restoration against the document scroller (per-route window offset).
    useScrollRestoration('window', { enabled: true });

    const header = listHeaderComponent ?? (
        <FeedHeader showComposeButton={showComposeButton} onComposePress={onComposePress} hideHeader={hideHeader} />
    );

    const isLoadingMore = feedState.isLoading && count > 0;
    const showFooter = isLoadingMore || (!isAuthenticated && count > 0);

    const handleBoundaryError = useCallback((error: Error, errorInfo: React.ErrorInfo) => {
        logger.error('Error caught by boundary', { error, errorInfo });
    }, []);

    return (
        <ErrorBoundary
            title={t("error.boundary.title")}
            message={t("error.boundary.message")}
            retryLabel={t("error.boundary.retry")}
            onError={handleBoundaryError}
        >
            <View className="bg-background" style={merged.style}>
                {header}

                {count === 0 ? (
                    <FeedEmptyState
                        isLoading={feedState.isLoading}
                        error={feedState.error}
                        hasItems={false}
                        type={type}
                        showOnlySaved={showOnlySaved}
                        onRetry={handleRetry}
                        pending={feedState.pending}
                    />
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
                                const postUri = getItemKey(row.item);
                                return (
                                    <div
                                        key={virtualRow.key as React.Key}
                                        // Stable combined ref: virtualizer measurement
                                        // (data-index → height) + impression observer
                                        // (≥50% visibility) on the SAME row node, so
                                        // impression ratios reflect the real row geometry.
                                        ref={getRowRef(postUri)}
                                        data-index={virtualRow.index}
                                        style={{
                                            position: 'absolute',
                                            top: 0,
                                            left: 0,
                                            width: '100%',
                                            transform: `translateY(${virtualRow.start - virtualizer.options.scrollMargin}px)`,
                                        }}
                                    >
                                        {renderFeedRow(row, { router, threadLineColor: theme.colors.border, feedDescriptor })}
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

                {showFooter && (
                    <FeedFooter
                        showOnlySaved={showOnlySaved}
                        hasMore={feedState.hasMore}
                        isLoadingMore={isLoadingMore}
                        hasItems={count > 0}
                    />
                )}
            </View>
        </ErrorBoundary>
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

const arePropsEqual = (prevProps: FeedProps, nextProps: FeedProps): boolean => {
    if (
        prevProps.reloadKey !== nextProps.reloadKey ||
        prevProps.type !== nextProps.type ||
        prevProps.userId !== nextProps.userId ||
        prevProps.showOnlySaved !== nextProps.showOnlySaved ||
        prevProps.scrollEnabled !== nextProps.scrollEnabled ||
        prevProps.threaded !== nextProps.threaded ||
        prevProps.threadPostId !== nextProps.threadPostId ||
        prevProps.listHeaderComponent !== nextProps.listHeaderComponent
    ) {
        return false;
    }

    if (!shallowFiltersEqual(prevProps.filters, nextProps.filters)) {
        return false;
    }

    return true;
};

const MemoizedFeed = memo(Feed, arePropsEqual);
MemoizedFeed.displayName = 'Feed';
export default MemoizedFeed;
