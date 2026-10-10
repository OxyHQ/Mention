import React, { useCallback, useEffect, useMemo, useRef, useState, memo, forwardRef } from 'react';
import {
    StyleSheet,
    View,
    RefreshControl,
    Platform,
    ScrollView,
    type LayoutChangeEvent,
    type ViewToken,
    type ScrollViewProps,
    type ViewStyle,
} from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { useHeaderDockInset } from '@oxy.so/bloom/layout';
import Animated, {
    runOnJS,
    useAnimatedScrollHandler,
    useSharedValue,
    type AnimatedProps,
} from 'react-native-reanimated';
import { useFocusedScrollable } from '@/hooks/useFocusedScrollable';
import { useLayoutScroll } from '@/context/LayoutScrollContext';
import { useIsFocused } from 'expo-router';
import { useScrollRestoration } from '@oxy.so/bloom/scroll';
import { useRevealOwnNewPost } from '@/hooks/useRevealOwnNewPost';
import { getItemKey } from '@/utils/feedUtils';
import type { FlashListProps, FlashListRef } from '@shopify/flash-list';
import {
    getFeedScrollOffset,
    setFeedScrollOffset,
} from '@/stores/feedScrollStore';
import { VideoViewabilityProvider, VideoViewabilityScope } from '@/context/VideoPlaybackContext';
import {
    type FeedItem,
    type FeedRow,
    renderFeedRow,
    feedRowKey,
    feedRowType,
    feedRowStyles,
} from './feedRows';
import { type FeedProps, FeedErrorBoundary, areFeedPropsEqual, useFeedCore } from './useFeedCore';

// FlashList v2 auto-measures every row, so no estimate is needed. `drawDistance`
// is the one render-ahead lever that still applies, and it is measured in
// PIXELS of runway ahead of the viewport.
//
// 250 was too little to be runway at all. A post row on a Pixel 10 Pro is
// 600-900px tall, so 250px is a third of one row: at fling speed — 2000px/s is
// an ordinary flick — it buys about 125ms before the reader is looking at a row
// that has not been mounted yet, which is the "posts appear a few seconds
// later" the app was reported for. The trade it was protecting against is real
// but bounded: FlashList recycles, and `maxItemsInRecyclePool` below caps what
// those extra rows can cost.
//
// A little under half a screen is the number that makes the runway longer than
// the JS thread needs to build a row.
//
// Re-measured on a release build (#1103, docs/PERFORMANCE_BUDGETS.md): 500 and
// 250 drew no blank rows on a Pixel 8a, but saved no measurable JS time and
// 5-17 MB of RSS. The scroll's JS cost is Fabric re-laying out the tree, not
// render-ahead rows (#1280), so the margin stays.
const FEED_DRAW_DISTANCE = 1000;

/**
 * How far the reader has to travel before the scroll worklet tells the JS thread
 * where it is.
 *
 * The JS side wants the offset for two things, neither of which is per-frame
 * work: remembering where to reopen this feed, and noticing that the header has
 * left the screen so a video inside it stops claiming the audible slot. Both are
 * answered by "roughly here", and the exact resting offset arrives anyway when
 * the scroll ends. A sixth of a screen keeps the crossings honest while leaving
 * the JS thread free to build rows.
 */
const JS_SCROLL_REPORT_PX = 120;

/**
 * The list, as a reanimated component, so `onScroll` can be a worklet.
 *
 * Built once at module scope: `createAnimatedComponent` produces a new component
 * type on every call, and one built per render would remount the whole list on
 * every render of the feed.
 */
const AnimatedFlashList = Animated.createAnimatedComponent(
    // The row type survives the wrapper only if it is named here:
    // `createAnimatedComponent` erases the component's own generic, and an
    // erased `unknown` row would take `renderItem`, `keyExtractor` and
    // `getItemType` down with it.
    FlashList as React.ComponentType<FlashListProps<NativeFeedRow>>,
) as React.ComponentType<
    // And the ref is the list's own imperative handle, which is what the feed
    // registers as the active scrollable and drives on a restore. Reanimated
    // types its wrapper's ref as an `AnimatedRef`, which this one is not.
    AnimatedProps<FlashListProps<NativeFeedRow>> & {
        ref?: React.Ref<FlashListRef<NativeFeedRow>>;
    }
>;

// Impression viewability. `itemVisiblePercentThreshold: 50` matches the web
// IntersectionObserver's 50% gate. The ≥1s DWELL requirement is owned by the
// shared FeedImpressionTracker (not by `minimumViewTime`) so native and web
// qualify impressions identically; a small `minimumViewTime` only debounces
// FlashList's own callback against scroll jitter, it does NOT stack with the
// tracker's 1s gate. Must be a STABLE object — FlashList rejects a changing
// viewabilityConfig at runtime.
const IMPRESSION_VIEWABILITY_CONFIG = {
    itemVisiblePercentThreshold: 50,
    minimumViewTime: 100,
    waitForInteraction: false,
} as const;

interface AuxiliaryFeedRow {
    kind: 'auxiliary';
    key: 'content-header' | 'sticky-header' | 'leading';
    element: React.ReactElement;
}

type NativeFeedRow = FeedRow | AuxiliaryFeedRow;

const nativeFeedRowKey = (row: NativeFeedRow): string =>
    row.kind === 'auxiliary' ? `feed-${row.key}` : feedRowKey(row);

const nativeFeedRowType = (row: NativeFeedRow): string =>
    row.kind === 'auxiliary' ? `feed-${row.key}` : feedRowType(row);

const EMPTY_VIEWABLE_KEYS: ReadonlySet<string> = new Set<string>();
const EMPTY_ROW_KEYS: readonly string[] = [];

/**
 * Viewability key this list publishes for its `ListHeaderComponent`. The header
 * is NOT a data row, so it never appears in `onViewableItemsChanged` — its
 * on-screen state is derived from this list's own scroll offset and the header's
 * measured height instead, and handed to the players inside it through a
 * {@link VideoViewabilityScope}.
 */
const FEED_HEADER_VIEWABILITY_KEY = 'feed-header';

/**
 * The post a row renders NESTED inside itself, mirroring `PostItem`'s own
 * `nestedPost` resolution. Structural on purpose: `FeedItem` is a union of post /
 * reply / boost shapes and only some members carry these fields.
 */
type NestedPostSource = {
    boost?: { originalPost?: { id?: string } | null } | null;
    quotedPost?: { id?: string } | null;
    originalPost?: { id?: string } | null;
};

/**
 * Every post key a viewable row can render a video under.
 *
 * `renderFeedRow` renders a BOOST as its original post, and a quote renders its
 * quoted post as a nested `PostItem` — each of those reports ITS OWN post id as
 * the video's viewability key. Publishing only the row item's key would leave a
 * boosted or quoted video permanently "not visible", i.e. never playing.
 */
function collectRowVideoKeys(item: FeedItem, into: string[]): void {
    into.push(getItemKey(item));
    const nesting = item as NestedPostSource;
    const nestedId =
        nesting.boost?.originalPost?.id ?? nesting.quotedPost?.id ?? nesting.originalPost?.id;
    if (nestedId) into.push(String(nestedId));
}

function sameKeys(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
    if (a === b) return true;
    if (a.size !== b.size) return false;
    // Compared in ITERATION order, not merely by membership: the published order IS
    // the audible slot's ranking, so a reordered set is a real change.
    const next = b.values();
    for (const key of a) {
        if (next.next().value !== key) return false;
    }
    return true;
}

/**
 * A non-scrolling ScrollView replacement for FlashList.
 * When the Feed is embedded inside a parent ScrollView (e.g. profile screen),
 * the FlashList's internal ScrollView must not intercept touch/pan gestures,
 * otherwise the parent cannot scroll when the user drags from within the feed area.
 *
 * On web we render a plain View instead of a ScrollView so the browser never
 * treats the inner container as a scrollable region. A ScrollView (even with
 * scrollEnabled={false}) renders as an overflow-auto div on web, which can
 * intercept wheel events and prevent the parent Animated.ScrollView from
 * receiving them.
 */
const NonScrollingScrollComponent = forwardRef<ScrollView, ScrollViewProps>(
    (props, ref) => {
        if (Platform.OS === 'web') {
            // On web, strip ScrollView-only props and render a plain View so
            // wheel events propagate naturally to the parent scroll container.
            const {
                scrollEnabled: _se,
                nestedScrollEnabled: _ne,
                showsVerticalScrollIndicator: _sv,
                showsHorizontalScrollIndicator: _sh,
                overScrollMode: _os,
                onScroll: _onScroll,
                scrollEventThrottle: _set,
                contentContainerStyle,
                refreshControl: _rc,
                stickyHeaderIndices: _shi,
                ...viewProps
            } = props;

            return (
                <View
                    {...viewProps}
                    ref={ref as React.Ref<View>}
                    style={[props.style, { overflow: 'visible' as const }]}
                >
                    <View style={contentContainerStyle}>
                        {props.children}
                    </View>
                </View>
            );
        }

        return (
            <ScrollView
                {...props}
                ref={ref}
                scrollEnabled={false}
                nestedScrollEnabled={false}
                showsVerticalScrollIndicator={false}
                showsHorizontalScrollIndicator={false}
                // On Android, disabling overScroll prevents the inner container from
                // consuming fling gestures that should propagate to the parent.
                overScrollMode="never"
            />
        );
    }
);
NonScrollingScrollComponent.displayName = 'NonScrollingScrollComponent';

/**
 * The native feed: FlashList, scrolled on the UI thread. What the feed shows and
 * does comes from {@link useFeedCore}; this file owns only how it scrolls.
 */
const Feed = ((props: FeedProps) => {
    const core = useFeedCore(props);
    const {
        props: {
            type,
            hideRefreshControl,
            scrollEnabled,
            style,
            contentContainerStyle,
            listContentHeaderComponent,
            listStickyHeaderComponent,
        },
        theme,
        router,
        feedState,
        feedRows,
        leading,
        handleLoadMore,
        handleRefresh,
        refreshing,
        feedDescriptor,
        impressionTracker,
        receivesOwnNewPost,
    } = core;

    const headerDockInset = useHeaderDockInset();
    // With the (app) center now a Stack, multiple feed screens can be mounted at
    // once (e.g. the home feed stays mounted behind a pushed profile). Only the
    // FOCUSED feed may drive the shared scrollY (header/FAB/BottomBar hide) and be
    // the registered scrollable — otherwise a frozen background feed could move
    // the shared value.
    const isFocused = useIsFocused();
    const flatListRef = useRef<FlashListRef<NativeFeedRow> | null>(null);
    const { scrollPosition, scrollEventThrottle } = useLayoutScroll();

    // Fixed top inset for a feed that scrolls BEHIND an auto-hiding header + tab
    // bar overlay. Reserved as constant scrollable top padding so the overlay
    // chrome only translates and never reflows the list.
    const topInset = 0;

    // Bloom is a no-op on native today, but pass the same identity sub-key used
    // on web so feeds hosted by one route can never share an offset if native
    // restoration becomes active.
    useScrollRestoration(flatListRef, {
        enabled: scrollEnabled !== false,
        key: feedState.feedScrollKey,
    });

    const listRows = useMemo<NativeFeedRow[]>(() => {
        const auxiliaryRows: AuxiliaryFeedRow[] = [];
        if (listContentHeaderComponent) {
            auxiliaryRows.push({ kind: 'auxiliary', key: 'content-header', element: listContentHeaderComponent });
        }
        if (listStickyHeaderComponent) {
            auxiliaryRows.push({ kind: 'auxiliary', key: 'sticky-header', element: listStickyHeaderComponent });
        }
        if (leading) {
            auxiliaryRows.push({ kind: 'auxiliary', key: 'leading', element: leading });
        }
        return auxiliaryRows.length > 0
            ? [...auxiliaryRows, ...feedRows]
            : feedRows;
    }, [feedRows, listContentHeaderComponent, leading, listStickyHeaderComponent]);

    // Bloom intentionally delegates native restoration to the navigator, but a
    // route/tab swap can genuinely unmount a feed. Restore the last feed-scoped
    // offset once its retained rows are available; the imperative map avoids a
    // Zustand publication on every scroll frame.
    const restoredFeedKeyRef = useRef<string | null>(null);
    useEffect(() => {
        if (scrollEnabled === false || !isFocused) {
            restoredFeedKeyRef.current = null;
            return;
        }
        if (listRows.length === 0) return;
        const key = feedState.feedScrollKey;
        if (restoredFeedKeyRef.current === key) return;
        restoredFeedKeyRef.current = key;

        const offset = getFeedScrollOffset(key);
        if (offset <= 0) return;
        const frame = requestAnimationFrame(() => {
            flatListRef.current?.scrollToOffset({
                offset,
                animated: false,
            });
        });
        return () => cancelAnimationFrame(frame);
    }, [
        feedState.feedScrollKey,
        isFocused,
        listRows.length,
        scrollEnabled,
    ]);

    // The viewer's own new post goes in at the head of this list, but FlashList
    // keeps the old first row still, so the post sat above it, cut off under the
    // header. Bring it into view the next time this feed is in front — after the
    // restore above, which is declared first and so lands first.
    const revealOwnNewPost = useCallback(() => {
        setFeedScrollOffset(feedState.feedScrollKey, 0);
        flatListRef.current?.scrollToOffset({ offset: 0, animated: true });
    }, [feedState.feedScrollKey]);
    useRevealOwnNewPost({
        feedKey: feedState.feedScrollKey,
        enabled: scrollEnabled !== false
            && isFocused
            && listRows.length > 0
            && receivesOwnNewPost,
        scrollToTop: revealOwnNewPost,
    });

    // Memoize renderPostItem to prevent recreating on every render
    const renderPostItem = useCallback(({ item: row }: { item: NativeFeedRow; index: number }) => {
        // An auxiliary row (sticky header, a profile's pinned post) IS a real list
        // row, so the list reports whether it is on screen — but the players inside
        // it are keyed by post id, which this list cannot know. Scope the subtree to
        // the ROW's own key so it goes silent when the row scrolls away.
        if (row.kind === 'auxiliary') {
            return (
                <VideoViewabilityScope viewabilityKey={nativeFeedRowKey(row)}>
                    {row.element}
                </VideoViewabilityScope>
            );
        }
        return renderFeedRow(row, { router, threadLineColor: theme.colors.border, feedDescriptor });
    }, [router, theme.colors.border, feedDescriptor]);

    // Everything currently on screen, published to the video playback authority in
    // on-screen order (native has no IntersectionObserver, so this list IS the
    // visibility source for the players inside it). Two inputs feed it — FlashList's
    // viewability tokens for the rows, and this list's own scroll geometry for the
    // header, which is not a row — so both are held imperatively and the published
    // set is rebuilt from them.
    const [viewableVideoKeys, setViewableVideoKeys] = useState<ReadonlySet<string>>(EMPTY_VIEWABLE_KEYS);
    const rowViewableKeysRef = useRef<readonly string[]>(EMPTY_ROW_KEYS);
    const headerOnScreenRef = useRef(false);
    const headerBottomRef = useRef(0);
    const scrollOffsetRef = useRef(0);

    const publishViewableKeys = useCallback(() => {
        const keys = new Set<string>();
        // The header sits above every row, so publishing it first makes a video
        // inside it outrank the rows for the single audible slot while it shows.
        if (headerOnScreenRef.current) keys.add(FEED_HEADER_VIEWABILITY_KEY);
        for (const key of rowViewableKeysRef.current) keys.add(key);
        setViewableVideoKeys((previous) => (sameKeys(previous, keys) ? previous : keys));
    }, []);

    // The header spans [topInset, topInset + height) of the scrollable content, so
    // it is on screen exactly while the scroll offset has not passed its bottom
    // edge. Starts false: until it has been measured, silence is the safe answer.
    //
    // An EMBEDDED feed (`scrollEnabled === false`) is scrolled by a parent it can
    // neither see nor measure, so it genuinely cannot report this — and an
    // unreportable subtree resolves to silent, never to "assume visible".
    const ownsScroll = scrollEnabled !== false;
    const syncHeaderOnScreen = useCallback(() => {
        const onScreen = ownsScroll && scrollOffsetRef.current < headerBottomRef.current;
        if (headerOnScreenRef.current === onScreen) return;
        headerOnScreenRef.current = onScreen;
        publishViewableKeys();
    }, [ownsScroll, publishViewableKeys]);

    const handleHeaderLayout = useCallback((event: LayoutChangeEvent) => {
        headerBottomRef.current = topInset + event.nativeEvent.layout.height;
        syncHeaderOnScreen();
    }, [topInset, syncHeaderOnScreen]);

    // Impression tracking: reconcile the full viewable set on each change.
    // FlashList REQUIRES a stable onViewableItemsChanged identity (it warns/throws
    // on a changing callback), so this is created ONCE and reads both the tracker
    // and the focus flag through ref objects. Only a FOCUSED feed REPORTS
    // impressions — a background feed isn't actually being viewed by the user —
    // but viewability itself is a fact about the list, so video visibility is
    // published either way (a blurred screen's players are gated on focus anyway).
    const isFocusedRef = useRef(isFocused);
    isFocusedRef.current = isFocused;
    const handleViewableItemsChanged = useCallback(
        ({ viewableItems }: { viewableItems: ViewToken[]; changed: ViewToken[] }) => {
            const visibleUris: string[] = [];
            const rowKeys: string[] = [];
            for (const token of viewableItems) {
                if (!token.isViewable) continue;
                const row = token.item as NativeFeedRow | undefined;
                if (!row) continue;
                // An auxiliary row produces no impression, but can hold a video (a
                // profile's pinned post), so it publishes its ROW key for the scope.
                if (row.kind === 'auxiliary') {
                    rowKeys.push(nativeFeedRowKey(row));
                    continue;
                }
                // Only post rows produce impressions — a recommendation card has no
                // post to report, and must never reach `/feed/mtn/interactions`.
                if (row.kind !== 'post' || !row.item) continue;
                visibleUris.push(getItemKey(row.item));
                collectRowVideoKeys(row.item, rowKeys);
            }
            rowViewableKeysRef.current = rowKeys;
            publishViewableKeys();
            if (!isFocusedRef.current) return;
            impressionTracker.current.syncVisible(visibleUris);
        },
        [impressionTracker, publishViewableKeys]
    );

    const keyExtractor = useCallback((row: NativeFeedRow) => nativeFeedRowKey(row), []);

    // CRITICAL: getItemType helps FlashList properly recycle components
    const getItemType = useCallback((row: NativeFeedRow) => nativeFeedRowType(row), []);

    // Optimized data hash for FlashList extraData - only recalculate when rows change.
    // Keys off `feedRowKey` so it covers BOTH row kinds (a post id is meaningless
    // for a recommendation card).
    const dataHash = useMemo(() => {
        const count = listRows.length;
        if (count === 0) return 'empty';
        const firstKey = nativeFeedRowKey(listRows[0]);
        const lastKey = nativeFeedRowKey(listRows[count - 1]);
        const midKey = count > 2 ? nativeFeedRowKey(listRows[Math.floor(count / 2)]) : '';
        return `${count}-${firstKey}-${midKey}-${lastKey}`;
    }, [listRows]);

    // Only the focused, scroll-owning feed is the registered scrollable; a
    // background feed never moves the shared scrollY. A list claims the slot at
    // the top it mounted at.
    const claimScroll = useFocusedScrollable<FlashListRef<NativeFeedRow>>({
        enabled: scrollEnabled !== false,
        initialOffset: 0,
    });
    const assignListRef = useCallback((node: FlashListRef<NativeFeedRow> | null) => {
        flatListRef.current = node;
        claimScroll(node);
    }, [claimScroll]);

    /**
     * The bookkeeping a scroll owes the JS thread: where to reopen this feed, and
     * whether the header (which is not a row, so no viewability token describes
     * it) still has a video on screen.
     *
     * Called from the scroll worklet through `runOnJS`, and deliberately NOT once
     * per frame — see the handler below.
     */
    const reportScrollOffset = useCallback((offsetY: number) => {
        if (scrollEnabled === false || !isFocused) return;
        setFeedScrollOffset(feedState.feedScrollKey, offsetY);
        scrollOffsetRef.current = offsetY;
        syncHeaderOnScreen();
    }, [feedState.feedScrollKey, scrollEnabled, isFocused, syncHeaderOnScreen]);

    /** The last offset handed to the JS thread, so the worklet can ration them. */
    const lastReportedOffset = useSharedValue(0);

    /**
     * THE CHROME MOVES ON THE UI THREAD, and this is the whole reason the feed
     * hands reanimated its scroll instead of a JS callback.
     *
     * The auto-hiding header, the home tab strip and the bottom bar all integrate
     * their position from `scrollPosition` in a `useAnimatedReaction` worklet
     * (`BottomBarVisibilityContext`). That worklet runs on the UI thread — but the
     * value it reads used to be WRITTEN from JS, one `onScroll` callback at a
     * time. So the chrome could only move as often as the JS thread was free, and
     * during a fling the JS thread is busy building rows: measured at ~40ms of JS
     * per row on a Pixel 10 Pro. The header froze and then jumped, on exactly the
     * gesture where the reader is looking at it.
     *
     * As a worklet the offset reaches the shared value on the frame the scroll
     * happened, whatever JS is doing.
     *
     * The JS side still needs the offset, but not sixty times a second: it is
     * reported every `JS_SCROLL_REPORT_PX` of travel, and exactly once more when
     * the scroll comes to rest — so what gets persisted for a reopen is the
     * offset the reader actually stopped at, not a rounded-off one.
     */
    const handleScrollEvent = useAnimatedScrollHandler({
        onScroll: (event) => {
            'worklet';
            const offsetY = event.contentOffset.y;
            scrollPosition.value = offsetY;
            if (Math.abs(offsetY - lastReportedOffset.value) < JS_SCROLL_REPORT_PX) return;
            lastReportedOffset.value = offsetY;
            runOnJS(reportScrollOffset)(offsetY);
        },
        onEndDrag: (event) => {
            'worklet';
            lastReportedOffset.value = event.contentOffset.y;
            runOnJS(reportScrollOffset)(event.contentOffset.y);
        },
        onMomentumEnd: (event) => {
            'worklet';
            lastReportedOffset.value = event.contentOffset.y;
            runOnJS(reportScrollOffset)(event.contentOffset.y);
        },
    });

    // Memoize RefreshControl to prevent recreation on every render. When the feed
    // scrolls behind the overlay chrome, offset the pull-to-refresh spinner by the
    // chrome inset so it appears below the chrome instead of behind it.
    const refreshControl = useMemo(() => {
        if (hideRefreshControl) return undefined;
        return (
            <RefreshControl
                refreshing={refreshing}
                onRefresh={handleRefresh}
                colors={[theme.colors.primary]}
                tintColor={theme.colors.primary}
                progressViewOffset={topInset || undefined}
            />
        );
    }, [hideRefreshControl, refreshing, handleRefresh, theme.colors.primary, topInset]);

    const containerStyle = feedRowStyles.container;

    // Memoize list content style. `topInset` reserves the overlay-chrome height as
    // constant scrollable top padding (native home/explore) so hiding the chrome
    // never reflows the list; caller-supplied `contentContainerStyle` is applied
    // last so an explicit override still wins.
    const listContentStyle = useMemo(
        () =>
            StyleSheet.flatten([
                feedRowStyles.listContent,
                topInset > 0 ? { paddingTop: topInset } : null,
                contentContainerStyle,
            ]),
        [contentContainerStyle, topInset]
    );

    // Memoize list style - when scroll is disabled (embedded in a parent ScrollView),
    // avoid flex: 1 which collapses to zero height in a non-flex scroll content container.
    // FlashList v2 types `style` as a single ViewStyle (not StyleProp), so flatten here.
    const listStyle = useMemo<ViewStyle>(
        () =>
            StyleSheet.flatten([
                scrollEnabled === false ? feedRowStyles.listEmbedded : feedRowStyles.list,
                style,
            ]),
        [style, scrollEnabled]
    );

    // Memoize header component. The header is not a data row, so it gets no
    // viewability token: it is measured here instead, and the players inside it —
    // the focused post on the post-detail screen, for one — read the resulting
    // on-screen state through the scope rather than being assumed visible.
    const headerComponent = useMemo(
        () => (
            <VideoViewabilityScope viewabilityKey={FEED_HEADER_VIEWABILITY_KEY}>
                <View
                    onLayout={handleHeaderLayout}
                    // FlashList may stretch its header wrapper to the viewport
                    // when it is the first child of a flex list. The header is
                    // document content; its height must be its measured content
                    // height so the following sticky row starts immediately.
                    style={{ flexGrow: 0, flexShrink: 0, alignSelf: 'stretch' }}
                >
                    {core.header}
                </View>
            </VideoViewabilityScope>
        ),
        [core.header, handleHeaderLayout]
    );

    const hasAuxiliaryRows = listRows.length > feedRows.length;
    const renderedEmptyComponent = hasAuxiliaryRows ? null : core.emptyState;
    const renderedFooterComponent = feedRows.length === 0 && hasAuxiliaryRows
        ? core.emptyState
        : core.footer;

    return (
        <FeedErrorBoundary>
            <View
                className={scrollEnabled === false ? undefined : "flex-1"}
                style={[{ minHeight: 0 }, scrollEnabled !== false && containerStyle]}
            >
                {/* This list owns viewability for every video inside it: a player
                    whose row is not viewable is not visible, so it cannot play. */}
                <VideoViewabilityProvider viewableKeys={viewableVideoKeys}>
                    <AnimatedFlashList
                        ref={assignListRef}
                        data={listRows}
                        renderItem={renderPostItem}
                        keyExtractor={keyExtractor}
                        getItemType={getItemType}
                        extraData={dataHash}
                        ListHeaderComponent={headerComponent}
                        ListHeaderComponentStyle={{ flexGrow: 0, flexShrink: 0, alignSelf: 'stretch' }}
                        ListEmptyComponent={renderedEmptyComponent}
                        ListFooterComponent={renderedFooterComponent}
                        // The Bloom sticky section is the first data row. FlashList
                        // keeps ListHeaderComponent outside the data index space.
                    stickyHeaderIndices={listStickyHeaderComponent ? [listContentHeaderComponent ? 1 : 0] : undefined}
                        stickyHeaderConfig={{ offset: headerDockInset }}
                        scrollEnabled={scrollEnabled}
                        {...(scrollEnabled === false ? { renderScrollComponent: NonScrollingScrollComponent } : {})}
                        refreshControl={refreshControl}
                        onEndReached={handleLoadMore}
                        // TWO SCREENS of warning, not two thirds of one. The
                        // threshold is in viewport lengths, and the next page
                        // costs a round trip to us-west-2 — measured at ~600ms
                        // from Europe, before the server does any work. At 0.7
                        // the reader reached the end of the list while that
                        // request was still in flight, every time they scrolled
                        // with intent; the spinner they saw was the network, not
                        // the feed.
                        onEndReachedThreshold={2}
                        onViewableItemsChanged={handleViewableItemsChanged}
                        viewabilityConfig={IMPRESSION_VIEWABILITY_CONFIG}
                        showsVerticalScrollIndicator={false}
                        keyboardShouldPersistTaps="handled"
                        onScroll={scrollEnabled === false ? undefined : handleScrollEvent}
                        scrollEventThrottle={scrollEnabled === false ? undefined : scrollEventThrottle}
                        contentContainerStyle={listContentStyle}
                        style={listStyle}
                        // FlashList v2 perf levers. v2 auto-measures rows (no
                        // estimatedItemSize) and recycles by `getItemType`; the v1/FlatList
                        // props (maxToRenderPerBatch, windowSize, initialNumToRender,
                        // updateCellsBatchingPeriod, removeClippedSubviews) and the
                        // size-setting overrideItemLayout were no-ops here and have been
                        // dropped. Cap the recycle pool so off-screen rows release memory
                        // instead of accumulating during long sessions.
                        drawDistance={FEED_DRAW_DISTANCE}
                        maxItemsInRecyclePool={20}
                    />
                </VideoViewabilityProvider>
            </View>
        </FeedErrorBoundary>
    );
});

const MemoizedFeed = memo(Feed, areFeedPropsEqual);
MemoizedFeed.displayName = 'Feed';
export default MemoizedFeed;
