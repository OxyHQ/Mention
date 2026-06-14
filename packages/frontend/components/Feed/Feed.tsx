import React, { useCallback, useEffect, useMemo, useRef, useState, memo, forwardRef } from 'react';
import {
    StyleSheet,
    View,
    RefreshControl,
    Platform,
    Pressable,
    Text,
    ScrollView,
    type ScrollViewProps,
} from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { FeedType, HydratedPost, Reply, FeedBoost as Boost, FeedPostSlice, FeedSliceReason } from '@mention/shared-types';
import PostItem from './PostItem';
import { ErrorBoundary } from '@oxyhq/bloom/error-boundary';
import { PostErrorBoundary } from './PostErrorBoundary';
import { useAuth } from '@oxyhq/services';
import { useTheme } from '@oxyhq/bloom/theme';
import { useLayoutScroll, extractOffsetY } from '@/context/LayoutScrollContext';
import { flattenStyleArray } from '@/utils/theme';
import { useRouter, useIsFocused, useFocusEffect } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { createScopedLogger } from '@/lib/logger';
import { useFeedState } from '@/hooks/useFeedState';
import { useDeepCompareMemo } from '@/hooks/useDeepCompare';
import { FeedFilters, getItemKey, deduplicateItems, deepEqual, buildReplyTree, ReplyNode, buildFeedScrollKey } from '@/utils/feedUtils';
import { getFeedScroll, setFeedScroll } from '@/stores/feedScrollStore';
import type { FlashListRef } from '@shopify/flash-list';
import { THREAD_LINE_WIDTH, THREAD_LINE_BORDER_RADIUS, THREAD_LINE_Z_INDEX } from '@/components/Compose/composeLayout';
import { FeedHeader } from './FeedHeader';
import { FeedFooter } from './FeedFooter';
import { FeedEmptyState } from './FeedEmptyState';
import { usePrivacyControls } from '@/hooks/usePrivacyControls';
import { extractAuthorId } from '@/utils/postUtils';

// Type alias for feed items (what PostItem expects)
type FeedItem = HydratedPost | Reply | Boost;

// Row type for FlashList with thread state
interface FeedRow {
    item: FeedItem;
    sliceKey: string;
    isThreadParent: boolean;
    isThreadChild: boolean;
    isThreadLastChild: boolean;
    isIncompleteThread: boolean;
    sliceReason?: FeedSliceReason;
    nestingDepth: number;
    truncatedChildCount: number;
}

const MAX_THREAD_NESTING_DEPTH = 3;

// On web, a screen hidden with `display:none` (React Navigation background
// screens) has its scroll container `scrollTop` reset to 0. When the screen is
// re-shown on back navigation it needs a frame to lay out / become visible
// before `scrollToOffset` takes effect. We restore after two animation frames
// (one for the screen to become visible, one for layout to settle) and then
// verify; if the list is still at the top we retry once on the next frame.
const FOCUS_RESTORE_VERIFY_THRESHOLD_PX = 1;

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

const WEB_DATA_SET = { layoutscroll: 'true' } as const;

const overrideFeedItemLayout = (layout: { size?: number }) => {
    layout.size = 250;
};

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
                    ref={ref as any}
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
    const flatListRef = useRef<any>(null);
    const unregisterScrollableRef = useRef<(() => void) | null>(null);
    // Guards the one-shot scroll restore so it runs at most once per mount
    // (FlashList may fire onLoad more than once across re-layouts).
    const hasRestoredScrollRef = useRef(false);
    // Set true once the user actually scrolls during the current focus session.
    // While true, the focus-restore must not yank the list back — the user is in
    // control. Reset on each blur so the next focus gain re-arms restore.
    const userScrolledThisFocusRef = useRef(false);
    // Tracks pending requestAnimationFrame handles for the focus restore so the
    // focus-effect cleanup (blur) can cancel any in-flight restore.
    const focusRestoreRafRef = useRef<number | null>(null);
    // Mirror of the current row count, read inside the deferred focus restore
    // without adding `feedRows` to the focus-effect deps (which must depend only
    // on focus transitions). Restoring against an empty list would land past the
    // end, so the restore bails when there are no rows yet.
    const feedRowsCountRef = useRef(0);
    const [refreshing, setRefreshing] = useState(false);
    const { handleScroll, scrollEventThrottle, registerScrollable, forwardWheelEvent } = useLayoutScroll();

    // Determine if we should use scoped (local) feed state
    const useScoped = !!(filters && Object.keys(filters).length) && !showOnlySaved;

    // Stable identity for this feed instance — keys both the saved scroll offset
    // and (in memory mode) the retained items, so each feed restores independently
    // when its screen unmounts and remounts (e.g. open a video, then go back).
    // Mirrors the same key built inside useFeedState (pure function of the props).
    const feedScrollKey = useDeepCompareMemo(
        () => buildFeedScrollKey({ type, userId, showOnlySaved, filters }),
        [type, userId, showOnlySaved, filters]
    );

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

    // Destructure stable function references from feedState to avoid re-creating
    // callbacks whenever the feedState object identity changes.
    const { refresh: feedRefresh, loadMore: feedLoadMore, clearError: feedClearError, fetchInitial: feedFetchInitial } = feedState;

    // Handle refresh with loading state
    const handleRefresh = useCallback(async () => {
        setRefreshing(true);
        try {
            await feedRefresh();
        } catch (err) {
            logger.error('Error refreshing feed', { error: err });
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

    // Transform slices (or items) into FeedRows with thread state
    const feedRows = useDeepCompareMemo((): FeedRow[] => {
        const slices = feedState.slices;
        const src = feedState.items;

        // If we have slices, transform them into FeedRows with thread state
        if (slices && slices.length > 0) {
            const rows: FeedRow[] = [];
            for (const slice of slices) {
                for (let i = 0; i < slice.items.length; i++) {
                    const sliceItem = slice.items[i];
                    const post = sliceItem.post as FeedItem;
                    if (!post || !(post as any).id) continue;

                    // Privacy filter
                    if (blockedSet.size > 0) {
                        const authorId = extractAuthorId(post);
                        if (authorId && blockedSet.has(authorId)) continue;
                    }

                    rows.push({
                        item: post,
                        sliceKey: slice._sliceKey,
                        isThreadParent: i < slice.items.length - 1,
                        isThreadChild: i > 0,
                        isThreadLastChild: i === slice.items.length - 1 && i > 0,
                        isIncompleteThread: slice.isIncompleteThread,
                        sliceReason: slice.reason,
                        nestingDepth: 0,
                        truncatedChildCount: 0,
                    });
                }
            }
            return rows;
        }

        // Fallback: wrap flat items into single-post FeedRows (no thread state)
        if (src.length === 0) return [];

        const deduped = deduplicateItems(src, getItemKey);
        const filteredByPrivacy = blockedSet.size > 0
            ? deduped.filter((item) => {
                const authorId = extractAuthorId(item);
                return authorId ? !blockedSet.has(authorId) : true;
            })
            : deduped;

        // Threaded mode: build reply tree and flatten with nesting depth
        if (threaded && threadPostId && filteredByPrivacy.length > 0) {
            const tree = buildReplyTree(filteredByPrivacy, threadPostId);
            const rows: FeedRow[] = [];

            const flattenNode = (node: ReplyNode, depth: number) => {
                const item = node.reply as FeedItem;
                const isTruncated = depth >= MAX_THREAD_NESTING_DEPTH && node.children.length > 0;

                rows.push({
                    item,
                    sliceKey: getItemKey(item),
                    isThreadParent: node.children.length > 0 && !isTruncated,
                    isThreadChild: depth > 0,
                    isThreadLastChild: false,
                    isIncompleteThread: isTruncated,
                    nestingDepth: depth,
                    truncatedChildCount: isTruncated ? node.children.length : 0,
                });

                if (!isTruncated) {
                    for (const child of node.children) {
                        flattenNode(child, depth + 1);
                    }
                }
            };

            for (const node of tree) {
                flattenNode(node, 0);
            }

            return rows;
        }

        // Sort recent user posts to top for for_you feed
        let finalItems = filteredByPrivacy;
        const effectiveType = (showOnlySaved ? 'saved' : type) as FeedType;
        if (effectiveType === 'for_you' && currentUser?.id && filteredByPrivacy.length > 0) {
            const now = Date.now();
            const THRESHOLD_MS = 60 * 1000;
            const mineNow: Array<{ item: FeedItem; ts: number }> = [];
            const others: FeedItem[] = [];

            for (const item of filteredByPrivacy) {
                const ownerId = (item as any)?.user?.id;
                if ((item as any)?.isLocalNew || ownerId === currentUser.id) {
                    const d = (item as any)?.date || (item as any)?.createdAt;
                    const ts = d ? Date.parse(d) : 0;
                    if (ts && now - ts <= THRESHOLD_MS) {
                        mineNow.push({ item, ts });
                    } else {
                        others.push(item);
                    }
                } else {
                    others.push(item);
                }
            }

            if (mineNow.length > 0) {
                mineNow.sort((a, b) => b.ts - a.ts);
                finalItems = [...mineNow.map((x) => x.item), ...others];
            }
        }

        return finalItems.map((item) => ({
            item,
            sliceKey: getItemKey(item),
            isThreadParent: false,
            isThreadChild: false,
            isThreadLastChild: false,
            isIncompleteThread: false,
            nestingDepth: 0,
            truncatedChildCount: 0,
        }));
    }, [feedState.slices, feedState.items, type, showOnlySaved, currentUser?.id, blockedSet, threaded, threadPostId]);

    // Keep the latest row count in a ref so the deferred focus restore can bail
    // on an empty list without depending on `feedRows` (which would re-run the
    // focus effect on every data change). Render-phase write of a mirror value.
    feedRowsCountRef.current = feedRows.length;

    // Memoize renderPostItem to prevent recreating on every render
    const renderPostItem = useCallback(({ item: row }: { item: FeedRow; index: number }) => {
        const post = row.item;
        if (!post || !post.id) {
            logger.warn('Invalid post item', { post });
            return null;
        }

        const showThreadLink = row.isIncompleteThread && row.isThreadLastChild;
        const showMoreReplies = row.isIncompleteThread && row.truncatedChildCount > 0;
        const replyContextAuthor = row.isThreadChild && row.sliceReason?.type === 'replyContext'
            ? row.sliceReason.parentAuthor
            : undefined;
        const nestPadding = row.nestingDepth > 0 ? { paddingLeft: 16 * row.nestingDepth } : undefined;

        const content = (
            <PostErrorBoundary postId={post.id}>
                {replyContextAuthor && (
                    <View style={styles.replyContextLabel}>
                        <Text className="text-muted-foreground text-xs">
                            Replying to <Text className="text-primary text-xs">@{replyContextAuthor.handle || replyContextAuthor.displayName}</Text>
                        </Text>
                    </View>
                )}
                <PostItem
                    post={post}
                    isThreadParent={row.isThreadParent}
                    isThreadChild={row.isThreadChild}
                    isThreadLastChild={row.isThreadLastChild}
                    nestingDepth={row.nestingDepth}
                />
                {showThreadLink && (
                    <Pressable
                        className="border-border"
                        style={styles.showThreadLink}
                        onPress={() => router.push(`/p/${post.id}`)}
                    >
                        <Text className="text-primary text-sm font-medium">
                            Show this thread
                        </Text>
                    </Pressable>
                )}
                {showMoreReplies && (
                    <Pressable
                        style={[styles.showMoreReplies, nestPadding]}
                        onPress={() => router.push(`/p/${post.id}`)}
                    >
                        <Text className="text-primary text-sm font-medium">
                            Show more replies ({row.truncatedChildCount})
                        </Text>
                    </Pressable>
                )}
            </PostErrorBoundary>
        );

        if (nestPadding) {
            return (
                <View style={[styles.nestedRow, nestPadding]}>
                    <View style={[styles.nestedThreadLine, { backgroundColor: `${theme.colors.primary}30` }]} />
                    {content}
                </View>
            );
        }

        return content;
    }, [router, theme.colors.primary]);

    const keyExtractor = useCallback((row: FeedRow) => {
        // Use sliceKey + item id for unique key within a slice
        const itemId = getItemKey(row.item);
        return row.sliceKey !== itemId ? `${row.sliceKey}:${itemId}` : itemId;
    }, []);

    // CRITICAL: getItemType helps FlashList properly recycle components
    const getItemType = useCallback((row: FeedRow) => {
        if (row.nestingDepth > 0) return `nested_${row.nestingDepth}`;
        if (row.isThreadParent) return 'threadParent';
        if (row.isThreadChild) return 'threadChild';
        const item = row.item;
        if ((item as any)?.original || (item as any)?.boostOf) return 'boost';
        if ((item as any)?.quoted || (item as any)?.quoteOf) return 'quote';
        if ((item as any)?.parentPostId || (item as any)?.replyTo) return 'reply';
        return 'post';
    }, []);

    // Optimized data hash for FlashList extraData - only recalculate when items change
    const dataHash = useMemo(() => {
        const count = feedRows.length;
        if (count === 0) return 'empty';
        const firstKey = getItemKey(feedRows[0].item);
        const lastKey = getItemKey(feedRows[count - 1].item);
        const midKey = count > 2 ? getItemKey(feedRows[Math.floor(count / 2)].item) : '';
        return `${count}-${firstKey}-${midKey}-${lastKey}`;
    }, [feedRows]);

    // Register scrollable with LayoutScrollContext
    const clearScrollableRegistration = useCallback(() => {
        if (unregisterScrollableRef.current) {
            unregisterScrollableRef.current();
            unregisterScrollableRef.current = null;
        }
    }, []);

    const assignListRef = useCallback((node: any) => {
        flatListRef.current = node;
        clearScrollableRegistration();
        // Only the focused, scroll-owning feed registers as the active scrollable.
        if (scrollEnabled === false || !isFocused) return;
        if (node) {
            unregisterScrollableRef.current = registerScrollable(node);
        }
    }, [clearScrollableRegistration, registerScrollable, scrollEnabled, isFocused]);

    // Reconcile the registration with focus + scroll ownership. On focus (with a
    // mounted list and scrolling enabled) register so web `forwardWheelEvent`
    // targets this feed; on blur clear it so a background feed never steals wheel
    // targeting or moves the shared scrollY. `registerScrollable` returns a
    // counter-guarded cleanup, so the unmount effect below remains correct.
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

    // Handle scroll events. Drives the header-hide shared value (handleScroll)
    // and persists the current offset under this feed's identity so a later
    // remount can restore it. Embedded feeds (scrollEnabled === false) don't
    // own scrolling, so we skip both.
    const handleScrollEvent = useCallback((event: any) => {
        // Skip entirely when this feed isn't the focused screen: a frozen
        // background feed must never move the shared scrollY nor overwrite its
        // saved offset (it isn't actually being scrolled by the user).
        if (scrollEnabled === false || !isFocused) return;
        if (handleScroll) {
            handleScroll(event);
        }
        const offset = extractOffsetY(event);
        // The user is driving the scroll this focus session — once they've moved
        // it themselves, the focus-restore must not yank it back.
        userScrolledThisFocusRef.current = true;
        setFeedScroll(feedScrollKey, offset);
    }, [handleScroll, scrollEnabled, isFocused, feedScrollKey]);

    // Restore the saved scroll offset once the list has measured/drawn its rows.
    // FlashList v2 lays items out after first render, so onLoad is the correct
    // timing hook. Guarded so it runs at most once per mount, only when there's
    // a meaningful saved offset and data is present, and never for embedded feeds
    // (which don't own scrolling — the parent ScrollView does).
    const handleListLoad = useCallback(() => {
        if (hasRestoredScrollRef.current) return;
        // Embedded feeds don't own scrolling — nothing to restore.
        if (scrollEnabled === false) return;
        // Wait until rows exist; restoring against an empty list would land on
        // a position past the end. onLoad only fires after first layout, so in
        // practice data is already present here in both SQLite and memory mode.
        if (feedRows.length === 0) return;
        // Consume the one-shot only once we actually have rows to restore against.
        hasRestoredScrollRef.current = true;
        const savedOffset = getFeedScroll(feedScrollKey);
        if (!savedOffset || savedOffset <= 0) return;
        const list = flatListRef.current as FlashListRef<FeedRow> | null;
        list?.scrollToOffset({ offset: savedOffset, animated: false });
    }, [feedScrollKey, scrollEnabled, feedRows.length]);

    // Restore the saved scroll offset when this feed regains focus (back
    // navigation). The Phase-1 <Stack> keeps background feed screens MOUNTED,
    // but on web React Navigation hides them with `display:none`, which resets
    // the scroll container's `scrollTop` to 0. Because the FlashList does not
    // remount when the screen is re-shown, `onLoad` does NOT re-fire — so the
    // initial-mount restore above can't help the back case. This focus effect
    // covers it: each fresh focus gain re-applies the saved offset once.
    //
    // Composition with the other scroll handlers:
    //   - onScroll (`handleScrollEvent`) keeps saving the latest offset and marks
    //     `userScrolledThisFocusRef` so we never fight an in-session user scroll.
    //   - onLoad (`handleListLoad`) still covers the genuine cold/initial mount.
    //   - This effect covers return-to-an-already-mounted-screen (back from
    //     /videos, /p/[id], etc.). The cleanup runs on blur, re-arming the guard.
    useFocusEffect(
        useCallback(() => {
            // A fresh focus gain re-arms the user-scroll guard for this session.
            userScrolledThisFocusRef.current = false;

            // Embedded feeds don't own scrolling — the parent ScrollView does.
            if (scrollEnabled !== false) {
                const savedOffset = getFeedScroll(feedScrollKey);
                if (savedOffset && savedOffset > 0) {
                    // Re-show on web needs a frame to become visible + lay out
                    // before scrollToOffset takes effect. Apply after a double
                    // rAF, then re-apply once more on a third frame as an
                    // idempotent safety retry in case the first apply raced the
                    // layout (scrolling to the same offset twice is invisible
                    // with animated:false).
                    const applyRestore = () => {
                        if (userScrolledThisFocusRef.current) return;
                        // Restoring against an empty list would scroll past the
                        // end; wait until rows exist (cold mount before data).
                        if (feedRowsCountRef.current === 0) return;
                        const list = flatListRef.current as FlashListRef<FeedRow> | null;
                        if (!list) return;
                        list.scrollToOffset({ offset: savedOffset, animated: false });
                        if (savedOffset <= FOCUS_RESTORE_VERIFY_THRESHOLD_PX) return;
                        focusRestoreRafRef.current = requestAnimationFrame(() => {
                            focusRestoreRafRef.current = null;
                            if (userScrolledThisFocusRef.current) return;
                            const verifyList = flatListRef.current as FlashListRef<FeedRow> | null;
                            verifyList?.scrollToOffset({ offset: savedOffset, animated: false });
                        });
                    };

                    focusRestoreRafRef.current = requestAnimationFrame(() => {
                        focusRestoreRafRef.current = requestAnimationFrame(applyRestore);
                    });
                }
            }

            return () => {
                // Blur: cancel any in-flight restore and reset the session guard
                // so the next focus gain restores fresh.
                if (focusRestoreRafRef.current !== null) {
                    cancelAnimationFrame(focusRestoreRafRef.current);
                    focusRestoreRafRef.current = null;
                }
                userScrolledThisFocusRef.current = false;
            };
        }, [feedScrollKey, scrollEnabled])
    );

    // Handle wheel events
    const handleWheelEvent = useCallback((event: any) => {
        if (forwardWheelEvent) {
            forwardWheelEvent(event);
        }
    }, [forwardWheelEvent]);

    // Web-specific dataSet for scroll detection
    const dataSetForWeb = Platform.OS === 'web' ? WEB_DATA_SET : undefined;

    // Memoize RefreshControl to prevent recreation on every render
    const refreshControl = useMemo(() => {
        if (hideRefreshControl) return undefined;
        return (
            <RefreshControl
                refreshing={refreshing}
                onRefresh={handleRefresh}
                colors={[theme.colors.primary]}
                tintColor={theme.colors.primary}
            />
        );
    }, [hideRefreshControl, refreshing, handleRefresh, theme.colors.primary]);

    const containerStyle = styles.container;

    // Memoize list content style
    const listContentStyle = useMemo(
        () =>
            flattenStyleArray([
                styles.listContent,
                contentContainerStyle,
            ]),
        [contentContainerStyle]
    );

    // Memoize list style - when scroll is disabled (embedded in a parent ScrollView),
    // avoid flex: 1 which collapses to zero height in a non-flex scroll content container.
    const listStyle = useMemo(
        () =>
            flattenStyleArray([
                scrollEnabled === false ? styles.listEmbedded : styles.list,
                style,
            ]),
        [style, scrollEnabled]
    );

    // Memoize header component
    const headerComponent = useMemo(
        () => listHeaderComponent ?? <FeedHeader showComposeButton={showComposeButton} onComposePress={onComposePress} hideHeader={hideHeader} />,
        [listHeaderComponent, showComposeButton, onComposePress, hideHeader]
    );

    // Memoize empty state retry handler
    const handleRetry = useCallback(async () => {
        feedClearError();
        try {
            await feedFetchInitial(true);
        } catch (retryError) {
            logger.error('Retry failed', { error: retryError });
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
            <View
                className={scrollEnabled === false ? "bg-background" : "flex-1 bg-background"}
                style={[{ minHeight: 0 }, scrollEnabled !== false && containerStyle]}
                {...(Platform.OS === 'web' && dataSetForWeb ? { 'data-layoutscroll': 'true' } : {})}
            >
                <FlashList
                    ref={assignListRef}
                    data={feedRows}
                    renderItem={renderPostItem}
                    keyExtractor={keyExtractor}
                    getItemType={getItemType}
                    onLoad={handleListLoad}
                    {...({
                        estimatedItemSize: 250,
                        extraData: dataHash,
                        ListHeaderComponent: headerComponent,
                        ListEmptyComponent: emptyStateComponent,
                        ListFooterComponent: showFooter ? footerComponent : null,
                        scrollEnabled: scrollEnabled,
                        ...(scrollEnabled === false ? { renderScrollComponent: NonScrollingScrollComponent } : {}),
                        refreshControl: refreshControl,
                        onEndReached: handleLoadMore,
                        onEndReachedThreshold: 0.7,
                        showsVerticalScrollIndicator: false,
                        keyboardShouldPersistTaps: 'handled',
                        onScroll: scrollEnabled === false ? undefined : handleScrollEvent,
                        scrollEventThrottle: scrollEnabled === false ? undefined : scrollEventThrottle,
                        onWheel: Platform.OS === 'web' ? handleWheelEvent : undefined,
                        contentContainerStyle: listContentStyle,
                        style: listStyle,
                        // Performance optimizations for FlashList
                        drawDistance: 600,
                        removeClippedSubviews: true,
                        maxToRenderPerBatch: 10,
                        windowSize: 10,
                        initialNumToRender: 12,
                        updateCellsBatchingPeriod: 50,
                        overrideItemLayout: overrideFeedItemLayout,
                    } as any)}
                />
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
        prevProps.listHeaderComponent !== nextProps.listHeaderComponent
    ) {
        return false;
    }

    // Deep comparison for filters using utility
    if (!deepEqual(prevProps.filters, nextProps.filters)) {
        return false;
    }

    // Props are equal, skip re-render
    return true;
};

const MemoizedFeed = memo(Feed, arePropsEqual);
MemoizedFeed.displayName = 'Feed';
export default MemoizedFeed;

const styles = StyleSheet.create({
    container: {
        flex: 1,
        minHeight: 0,
    },
    list: {
        flex: 1,
        minHeight: 0,
    },
    listEmbedded: {
        // When embedded inside a parent ScrollView (scrollEnabled=false),
        // avoid flex: 1 so the list sizes to its content instead of collapsing.
        minHeight: 0,
    },
    listContent: {
        flexGrow: 0,
        alignSelf: 'stretch',
    },
    showThreadLink: {
        paddingVertical: 10,
        paddingLeft: 64, // HPAD + AVATAR_SIZE + AVATAR_GAP
        paddingRight: 12,
        borderBottomWidth: StyleSheet.hairlineWidth,
    },
    replyContextLabel: {
        paddingLeft: 64, // HPAD + AVATAR_SIZE + AVATAR_GAP
        paddingTop: 8,
        paddingBottom: 2,
    },
    nestedRow: {
        position: 'relative',
    },
    nestedThreadLine: {
        position: 'absolute',
        left: 31, // PostItem HPAD(12) + AVATAR_SIZE(40)/2 - 1
        top: 0,
        bottom: 0,
        width: THREAD_LINE_WIDTH,
        borderRadius: THREAD_LINE_BORDER_RADIUS,
        zIndex: THREAD_LINE_Z_INDEX,
    },
    showMoreReplies: {
        paddingVertical: 10,
        paddingLeft: 16,
        paddingRight: 12,
    },
});
