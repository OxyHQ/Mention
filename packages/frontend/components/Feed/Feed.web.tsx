import React, { useCallback, useLayoutEffect, useMemo, useRef, useState, memo } from 'react';
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
import { FeedFilters, deepEqual } from '@/utils/feedUtils';
import { FeedHeader } from './FeedHeader';
import { FeedFooter } from './FeedFooter';
import { FeedEmptyState } from './FeedEmptyState';
import { usePrivacyControls } from '@/hooks/usePrivacyControls';
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

// Pull the next page when the last few rows enter the virtual window.
const END_REACHED_ROW_THRESHOLD = 6;

/**
 * Shared data wiring used by both the virtualized (scroll-owning) and embedded
 * web feeds. Returns the live row set plus the load-more / retry handlers, so
 * the two render paths never diverge on data behavior.
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
    const { user: currentUser, isAuthenticated } = useAuth();
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

    // On web, an anonymous viewer must NEVER be auto-redirected to sign-in while
    // scrolling: web `signIn()` resolves to `signInWithRedirect` (a top-level
    // bounce to auth.<apex>/sso), and the window virtualizer reaches the end
    // almost immediately on a short anonymous page — so calling it here would
    // hijack public browse the instant the feed mounts. Anonymous pagination is
    // simply a no-op; the passive "Sign in to see more" footer (rendered via
    // `showFooter` below) is the ONLY sign-in affordance and fires `signIn()`
    // exclusively on user tap. (Native opens a modal, so its Feed.native.tsx
    // can keep the eager prompt; this divergence is intentional and web-only.)
    const handleLoadMore = useCallback(() => {
        if (!isAuthenticated) return;
        if (!feedState.hasMore || feedState.isLoading) return;
        feedLoadMore();
    }, [feedState.hasMore, feedState.isLoading, feedLoadMore, isAuthenticated]);

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
        currentUserId: currentUser?.id,
        handleLoadMore,
        handleRetry,
        handleRefresh,
    };
}

/**
 * EMBEDDED web feed (scrollEnabled === false): a non-virtualized plain list that
 * composes inside a parent scroller (e.g. the profile tab inside the profile
 * page's scroll view, or a list-detail ScrollView). Window-virtualizing an
 * embedded feed is wrong — it would track the document scroll, not the parent.
 * Mirrors native's embedded mode.
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
                            {renderFeedRow(row, { router, primaryColor: theme.colors.primary })}
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
 * works from anywhere, including over the sticky side columns); only the rows
 * in the virtual window are mounted, so the DOM stays bounded.
 */
function VirtualizedWebFeed(props: FeedProps) {
    const merged = { ...DEFAULT_FEED_PROPS, ...props };
    const { hideHeader, showComposeButton, onComposePress, listHeaderComponent, type, showOnlySaved } = merged;
    const { t } = useTranslation();
    const theme = useTheme();
    const router = useRouter();

    const {
        feedRows,
        feedState,
        isAuthenticated,
        handleLoadMore,
        handleRetry,
    } = useWebFeed(merged);

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

    // Infinite pagination: when the last rendered virtual row is within the
    // threshold of the end, request the next page. Guarded inside handleLoadMore
    // (hasMore / isLoading / auth), so calling it eagerly is safe.
    const lastVirtualIndex = virtualItems.length > 0 ? virtualItems[virtualItems.length - 1].index : 0;
    const nearEnd = count > 0 && lastVirtualIndex >= count - END_REACHED_ROW_THRESHOLD;
    const prevNearEndRef = useRef(false);
    if (nearEnd && !prevNearEndRef.current) {
        prevNearEndRef.current = true;
        handleLoadMore();
    } else if (!nearEnd && prevNearEndRef.current) {
        prevNearEndRef.current = false;
    }

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
                            style={{ height: totalSize, width: '100%', position: 'relative' }}
                        >
                            {virtualItems.map((virtualRow) => {
                                const row = feedRows[virtualRow.index];
                                return (
                                    <div
                                        key={virtualRow.key as React.Key}
                                        ref={virtualizer.measureElement}
                                        data-index={virtualRow.index}
                                        style={{
                                            position: 'absolute',
                                            top: 0,
                                            left: 0,
                                            width: '100%',
                                            transform: `translateY(${virtualRow.start - virtualizer.options.scrollMargin}px)`,
                                        }}
                                    >
                                        {renderFeedRow(row, { router, primaryColor: theme.colors.primary })}
                                    </div>
                                );
                            })}
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

    if (!deepEqual(prevProps.filters, nextProps.filters)) {
        return false;
    }

    return true;
};

const MemoizedFeed = memo(Feed, arePropsEqual);
MemoizedFeed.displayName = 'Feed';
export default MemoizedFeed;
