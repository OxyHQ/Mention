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
import type { FeedType } from '@mention/shared-types';
import { ErrorBoundary } from '@oxyhq/bloom/error-boundary';
import { useAuth } from '@oxyhq/services/ui/client';
import { useTheme } from '@oxyhq/bloom/theme';
import { useLayoutScroll, type ScrollEvent } from '@/context/LayoutScrollContext';
import { flattenStyleArray } from '@/styles/shared';
import { useRouter, useIsFocused } from 'expo-router';
import { useScrollRestoration } from '@oxyhq/bloom/scroll';
import { useTranslation } from 'react-i18next';
import { createLogger } from '@oxyhq/core/logger';
import { useFeedState } from '@/hooks/useFeedState';
import { useDeepCompareMemo } from '@/hooks/useDeepCompare';
import { FeedFilters, getItemKey, shallowFiltersEqual } from '@/utils/feedUtils';
import type { FlashListRef } from '@shopify/flash-list';
import { FeedHeader } from './FeedHeader';
import { FeedFooter } from './FeedFooter';
import { FeedEmptyState } from './FeedEmptyState';
import { usePrivacyControls } from '@/hooks/usePrivacyControls';
import {
    getFeedScrollOffset,
    setFeedScrollOffset,
} from '@/stores/feedScrollStore';
import { usePanelChromeTopInset } from '@/components/shell/PanelChrome';
import { resolveFeedDescriptor, useFeedImpressionTracker } from '@/utils/feedTelemetry';
import { VideoViewabilityProvider, VideoViewabilityScope } from '@/context/VideoPlaybackContext';
import {
    type FeedItem,
    type FeedRow,
    buildFeedRows,
    renderFeedRow,
    feedRowKey,
    feedRowType,
    feedRowStyles,
} from './feedRows';

const logger = createLogger('Feed');

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
    /**
     * A data-row header that sticks independently from `listHeaderComponent`.
     * Kept separate so callers can scroll a large summary away while pinning
     * only the compact navigation row below it.
     */
    listStickyHeaderComponent?: React.ReactElement | null;
    /** Optional non-sticky row rendered immediately after the sticky header. */
    listLeadingComponent?: React.ReactElement | null;
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

// FlashList v2 auto-measures every row, so no estimate is needed. `drawDistance`
// is the one render-ahead lever that still applies: keep it modest so we don't
// mount far-offscreen post rows (each row is relatively heavy) every frame.
const FEED_DRAW_DISTANCE = 250;

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
    key: 'sticky-header' | 'leading';
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

const Feed = ((props: FeedProps) => {
    const {
        type,
        userId,
        showComposeButton,
        onComposePress,
        hideHeader,
        hideRefreshControl,
        scrollEnabled,
        showOnlySaved,
        filters,
        reloadKey,
        style,
        contentContainerStyle,
        listHeaderComponent,
        listStickyHeaderComponent,
        listLeadingComponent,
        threaded,
        threadPostId,
    } = { ...DEFAULT_FEED_PROPS, ...props };

    const { t } = useTranslation();
    const theme = useTheme();
    const router = useRouter();
    // With the (app) center now a Stack, multiple feed screens can be mounted at
    // once (e.g. the home feed stays mounted behind a pushed profile). Only the
    // FOCUSED feed may drive the shared scrollY (header/FAB/BottomBar hide) and be
    // the registered scrollable for web wheel forwarding — otherwise a frozen
    // background feed could move the shared value or steal wheel targeting.
    const isFocused = useIsFocused();
    const flatListRef = useRef<FlashListRef<NativeFeedRow> | null>(null);
    const unregisterScrollableRef = useRef<(() => void) | null>(null);
    // The Bloom restoration hook is registered after feed identity is resolved.
    const [refreshing, setRefreshing] = useState(false);
    const { handleScroll, scrollEventThrottle, registerScrollable } = useLayoutScroll();

    // Fixed top inset for a feed that scrolls BEHIND an auto-hiding header + tab
    // bar overlay (home, explore). Reserved as constant scrollable top padding so
    // the overlay chrome only translates and never reflows the list. Native +
    // scroll-owning feeds only: embedded feeds (scrollEnabled === false) own no
    // scrolling, and on web the chrome is sticky in normal flow (no inset needed).
    const chromeTopInset = usePanelChromeTopInset();
    const topInset = Platform.OS === 'web' || scrollEnabled === false ? 0 : chromeTopInset;

    // Determine if we should use scoped (local) feed state
    const useScoped = !!(filters && Object.keys(filters).length) && !showOnlySaved;

    const { user: currentUser, isAuthenticated, signIn } = useAuth();
    const { blockedSet } = usePrivacyControls();

    // Use the feed state hook for all feed operations
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
    // Bloom is a no-op on native today, but pass the same identity sub-key used
    // on web so feeds hosted by one route can never share an offset if native
    // restoration becomes active.
    useScrollRestoration(flatListRef, {
        enabled: scrollEnabled !== false,
        key: feedState.feedScrollKey,
    });

    // Destructure stable function references from feedState to avoid re-creating
    // callbacks whenever the feedState object identity changes.
    const { refresh: feedRefresh, loadMore: feedLoadMore, clearError: feedClearError, fetchInitial: feedFetchInitial } = feedState;

    // Handle refresh with loading state
    const handleRefresh = useCallback(async () => {
        setRefreshing(true);
        try {
            await feedRefresh();
        } catch (err) {
            logger.error('Error refreshing feed', err);
        } finally {
            setRefreshing(false);
        }
    }, [feedRefresh]);

    // Handle load more - debounced in hook
    // For unauthenticated users, show sign-in prompt instead of loading more
    const handleLoadMore = useCallback(() => {
        if (!feedState.hasMore || feedState.isLoading) return;

        // If user is not authenticated, show sign-in prompt instead of loading more
        if (!isAuthenticated) {
            signIn().catch(() => {});
            return;
        }

        feedLoadMore();
    }, [feedState.hasMore, feedState.isLoading, feedLoadMore, isAuthenticated, signIn]);

    // Transform slices (or items) into FeedRows with thread state, and splice in
    // the server's recommendation cards.
    const feedRows = useDeepCompareMemo((): FeedRow[] => buildFeedRows({
        slices: feedState.slices,
        items: feedState.items,
        interstitials: feedState.interstitials,
        type,
        showOnlySaved,
        currentUserId: currentUser?.id,
        blockedSet,
        threaded,
        threadPostId,
    }), [feedState.slices, feedState.items, feedState.interstitials, type, showOnlySaved, currentUser?.id, blockedSet, threaded, threadPostId]);

    const listRows = useMemo<NativeFeedRow[]>(() => {
        const auxiliaryRows: AuxiliaryFeedRow[] = [];
        if (listStickyHeaderComponent) {
            auxiliaryRows.push({
                kind: 'auxiliary',
                key: 'sticky-header',
                element: listStickyHeaderComponent,
            });
        }
        if (listLeadingComponent) {
            auxiliaryRows.push({
                kind: 'auxiliary',
                key: 'leading',
                element: listLeadingComponent,
            });
        }
        return auxiliaryRows.length > 0
            ? [...auxiliaryRows, ...feedRows]
            : feedRows;
    }, [feedRows, listLeadingComponent, listStickyHeaderComponent]);

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

    // Feed-ranking telemetry: derive the descriptor this feed reports against and
    // own an impression tracker for the session. The session resets when the
    // descriptor changes or the feed is reloaded (reloadKey), so impressions are
    // counted once per post per session.
    const feedDescriptor = resolveFeedDescriptor(type, userId, filters, showOnlySaved);
    const impressionTracker = useFeedImpressionTracker(feedDescriptor, reloadKey);

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

    // Register scrollable with LayoutScrollContext
    const clearScrollableRegistration = useCallback(() => {
        if (unregisterScrollableRef.current) {
            unregisterScrollableRef.current();
            unregisterScrollableRef.current = null;
        }
    }, []);

    const assignListRef = useCallback((node: FlashListRef<NativeFeedRow> | null) => {
        flatListRef.current = node;
        clearScrollableRegistration();
        // Only the focused, scroll-owning feed registers as the active scrollable.
        if (scrollEnabled === false || !isFocused) return;
        if (node) {
            unregisterScrollableRef.current = registerScrollable(node);
        }
    }, [clearScrollableRegistration, registerScrollable, scrollEnabled, isFocused]);

    // Reconcile the registration with focus + scroll ownership. On focus (with a
    // mounted list and scrolling enabled) register this feed as the active
    // scrollable; on blur clear it so a background feed never moves the shared
    // scrollY. `registerScrollable` returns a counter-guarded cleanup, so the
    // unmount effect below remains correct.
    useEffect(() => {
        if (scrollEnabled === false || !isFocused) {
            clearScrollableRegistration();
            return;
        }
        if (flatListRef.current && !unregisterScrollableRef.current) {
            unregisterScrollableRef.current = registerScrollable(flatListRef.current);
        }
    }, [clearScrollableRegistration, registerScrollable, scrollEnabled, isFocused]);

    useEffect(() => () => {
        clearScrollableRegistration();
    }, [clearScrollableRegistration]);

    // Handle scroll events. Drives the header-hide shared value (handleScroll).
    // Scroll persistence/restoration is handled by `useScrollRestoration` above.
    // Embedded feeds (scrollEnabled === false) and frozen background feeds don't
    // own scrolling, so we skip.
    const handleScrollEvent = useCallback((event: ScrollEvent) => {
        // Skip entirely when this feed isn't the focused screen: a frozen
        // background feed must never move the shared scrollY (it isn't actually
        // being scrolled by the user).
        if (scrollEnabled === false || !isFocused) return;
        const contentOffset = event.nativeEvent?.contentOffset;
        const offsetY = typeof contentOffset === 'number'
            ? contentOffset
            : contentOffset?.y;
        if (typeof offsetY === 'number' && Number.isFinite(offsetY)) {
            setFeedScrollOffset(feedState.feedScrollKey, offsetY);
            // The header is not a data row, so this is the only signal that tells
            // the playback authority a video inside it has scrolled off screen.
            scrollOffsetRef.current = offsetY;
            syncHeaderOnScreen();
        }
        if (handleScroll) {
            handleScroll(event);
        }
    }, [feedState.feedScrollKey, handleScroll, scrollEnabled, isFocused, syncHeaderOnScreen]);

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
            flattenStyleArray([
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
                <View onLayout={handleHeaderLayout}>
                    {listHeaderComponent ?? <FeedHeader showComposeButton={showComposeButton} onComposePress={onComposePress} hideHeader={hideHeader} />}
                </View>
            </VideoViewabilityScope>
        ),
        [listHeaderComponent, showComposeButton, onComposePress, hideHeader, handleHeaderLayout]
    );

    // Memoize empty state retry handler
    const handleRetry = useCallback(async () => {
        feedClearError();
        try {
            await feedFetchInitial(true);
        } catch (retryError) {
            logger.error('Retry failed', retryError);
        }
    }, [feedClearError, feedFetchInitial]);

    const emptyStateComponent = useMemo(
        () => (
            <FeedEmptyState
                isLoading={feedState.isLoading}
                error={feedState.error}
                hasItems={false}
                type={type}
                showOnlySaved={showOnlySaved}
                onRetry={handleRetry}
                pending={feedState.pending}
            />
        ),
        [feedState.isLoading, feedState.error, feedState.pending, type, showOnlySaved, handleRetry]
    );

    // Track if we're loading more (loading while we already have items)
    const isLoadingMore = feedState.isLoading && feedRows.length > 0;

    // Show footer for loading more or sign-in prompt for unauthenticated users
    const showFooter = isLoadingMore || (!isAuthenticated && feedRows.length > 0);

    const footerComponent = useMemo(
        () => (
            <FeedFooter
                showOnlySaved={showOnlySaved}
                hasMore={feedState.hasMore}
                isLoadingMore={isLoadingMore}
                hasItems={feedRows.length > 0}
            />
        ),
        [showOnlySaved, feedState.hasMore, isLoadingMore, feedRows.length]
    );
    const hasAuxiliaryRows = listRows.length > feedRows.length;
    const renderedEmptyComponent = hasAuxiliaryRows ? null : emptyStateComponent;
    const renderedFooterComponent = feedRows.length === 0 && hasAuxiliaryRows
        ? emptyStateComponent
        : showFooter
            ? footerComponent
            : null;

    const handleBoundaryError = useCallback((error: Error, errorInfo: React.ErrorInfo) => {
        logger.error('Error caught by boundary', error, { errorInfo });
    }, []);

    return (
        <ErrorBoundary
            title={t("error.boundary.title")}
            message={t("error.boundary.message")}
            retryLabel={t("error.boundary.retry")}
            onError={handleBoundaryError}
        >
            <View
                className={scrollEnabled === false ? "bg-background" : "flex-1 bg-background"}
                style={[{ minHeight: 0 }, scrollEnabled !== false && containerStyle]}
            >
                {/* This list owns viewability for every video inside it: a player
                    whose row is not viewable is not visible, so it cannot play. */}
                <VideoViewabilityProvider viewableKeys={viewableVideoKeys}>
                    <FlashList
                        ref={assignListRef}
                        data={listRows}
                        renderItem={renderPostItem}
                        keyExtractor={keyExtractor}
                        getItemType={getItemType}
                        extraData={dataHash}
                        ListHeaderComponent={headerComponent}
                        ListEmptyComponent={renderedEmptyComponent}
                        ListFooterComponent={renderedFooterComponent}
                        stickyHeaderIndices={listStickyHeaderComponent ? [0] : undefined}
                        scrollEnabled={scrollEnabled}
                        {...(scrollEnabled === false ? { renderScrollComponent: NonScrollingScrollComponent } : {})}
                        refreshControl={refreshControl}
                        onEndReached={handleLoadMore}
                        onEndReachedThreshold={0.7}
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
        </ErrorBoundary>
    );
});

/**
 * Optimized props comparison to prevent unnecessary re-renders
 * Uses deep comparison for filters to avoid re-renders when filter objects change by reference only
 */
const arePropsEqual = (prevProps: FeedProps, nextProps: FeedProps): boolean => {
    // Fast path checks - most common changes
    if (
        prevProps.reloadKey !== nextProps.reloadKey ||
        prevProps.type !== nextProps.type ||
        prevProps.userId !== nextProps.userId ||
        prevProps.showOnlySaved !== nextProps.showOnlySaved ||
        prevProps.scrollEnabled !== nextProps.scrollEnabled ||
        prevProps.threaded !== nextProps.threaded ||
        prevProps.threadPostId !== nextProps.threadPostId ||
        prevProps.listHeaderComponent !== nextProps.listHeaderComponent ||
        prevProps.listStickyHeaderComponent !== nextProps.listStickyHeaderComponent ||
        prevProps.listLeadingComponent !== nextProps.listLeadingComponent
    ) {
        return false;
    }

    // Shallow comparison for the flat filters bag (avoids JSON.stringify).
    if (!shallowFiltersEqual(prevProps.filters, nextProps.filters)) {
        return false;
    }

    // Props are equal, skip re-render
    return true;
};

const MemoizedFeed = memo(Feed, arePropsEqual);
MemoizedFeed.displayName = 'Feed';
export default MemoizedFeed;
