import React, { useCallback, useEffect, useState, useMemo, useRef } from 'react';
import {
    StyleSheet,
    Text,
    TouchableOpacity,
    View,
    RefreshControl,
    ActivityIndicator,
    InteractionManager,
    Platform,
} from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { usePostsStore, useFeedSelector, useUserFeedSelector } from '../../stores/postsStore';
import { FeedType } from '@mention/shared-types';
import PostItem from './PostItem';
import ErrorBoundary from '../ErrorBoundary';
import LoadingTopSpinner from '../LoadingTopSpinner';
import { Error } from '../Error';
import { colors } from '../../styles/colors';
import { useOxy } from '@oxyhq/services';
import { feedService } from '../../services/feedService';
import { useFocusEffect } from 'expo-router';
import { useTheme } from '@/hooks/useTheme';
import { useIsScreenNotMobile } from '@/hooks/useOptimizedMediaQuery';
import { useLayoutScroll } from '@/context/LayoutScrollContext';
import { flattenStyleArray } from '@/utils/theme';
import { logger } from '@/utils/logger';

/**
 * Normalize item ID for consistent deduplication
 * Memoized outside component to prevent recreation on every render
 */
const normalizeId = (item: any): string => {
    if (item?.id) return String(item.id);
    if (item?._id) {
        const _id = item._id;
        return typeof _id === 'object' && typeof _id.toString === 'function'
            ? _id.toString()
            : String(_id);
    }
    if (item?._id_str) return String(item._id_str);
    if (item?.postId) return String(item.postId);
    if (item?.post?.id) return String(item.post.id);
    if (item?.post?._id) {
        const _id = item.post._id;
        return typeof _id === 'object' && typeof _id.toString === 'function'
            ? _id.toString()
            : String(_id);
    }
    return '';
};

interface FeedProps {
    type: FeedType;
    userId?: string;
    showComposeButton?: boolean;
    onComposePress?: () => void;
    hideHeader?: boolean;
    hideRefreshControl?: boolean;
    scrollEnabled?: boolean;
    showOnlySaved?: boolean;
    filters?: Record<string, any>;
    reloadKey?: string | number;
    autoRefresh?: boolean;
    refreshInterval?: number;
    onSavePress?: (postId: string) => void;
    style?: any;
    contentContainerStyle?: any;
    listHeaderComponent?: React.ReactElement | null;
    recycleItems?: boolean;
    maintainScrollAtEnd?: boolean;
    maintainScrollAtEndThreshold?: number;
    alignItemsAtEnd?: boolean;
    maintainVisibleContentPosition?: boolean;
}

const DEFAULT_FEED_PROPS = {
    showComposeButton: false,
    hideHeader: false,
    hideRefreshControl: false,
    scrollEnabled: true,
    showOnlySaved: false,
    autoRefresh: false,
    refreshInterval: 30000,
    recycleItems: true,
    maintainScrollAtEnd: false,
    maintainScrollAtEndThreshold: 0.1,
    alignItemsAtEnd: false,
    maintainVisibleContentPosition: true,
} as const;

const Feed = (props: FeedProps) => {
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
        autoRefresh: _autoRefresh,
        refreshInterval: _refreshInterval,
        onSavePress: _onSavePress,
        style,
        contentContainerStyle,
        listHeaderComponent,
        recycleItems: _recycleItems,
        maintainScrollAtEnd,
        maintainScrollAtEndThreshold,
        alignItemsAtEnd,
        maintainVisibleContentPosition,
    } = { ...DEFAULT_FEED_PROPS, ...props };
    const theme = useTheme();
    const isScreenNotMobile = useIsScreenNotMobile();
    const flatListRef = useRef<any>(null);
    const unregisterScrollableRef = useRef<(() => void) | null>(null);
    const [refreshing, setRefreshing] = useState(false);
    const [isLoadingMore, setIsLoadingMore] = useState(false);
    const { handleScroll, scrollEventThrottle, registerScrollable, forwardWheelEvent } = useLayoutScroll();

    // When filters are provided, scope the feed locally to avoid clashes
    // Exception: don't use scoped for saved posts - they use global feed state
    const useScoped = !!(filters && Object.keys(filters || {}).length) && !showOnlySaved;

    // Local state for scoped (filtered) feeds
    const [localItems, setLocalItems] = useState<any[]>([]);
    const [localHasMore, setLocalHasMore] = useState<boolean>(true);
    const [localNextCursor, setLocalNextCursor] = useState<string | undefined>(undefined);
    const [localLoading, setLocalLoading] = useState<boolean>(false);
    const [localError, setLocalError] = useState<string | null>(null);

    const effectiveType = (showOnlySaved ? 'saved' : type) as FeedType;
    const globalFeed = useFeedSelector(effectiveType);
    const userFeed = useUserFeedSelector(userId || '', effectiveType);
    const feedData = showOnlySaved ? globalFeed : (userId ? userFeed : globalFeed);

    const isLoading = useScoped ? localLoading : !!feedData?.isLoading;
    const error = useScoped ? localError : feedData?.error;
    const hasMore = useScoped ? localHasMore : !!feedData?.hasMore;

    // For saved posts, backend already returns only saved posts with isSaved: true
    // No need to filter on frontend - just use feedData directly
    const filteredFeedData = feedData;


    const {
        fetchFeed,
        fetchUserFeed,
        refreshFeed,
        loadMoreFeed,
        clearError
    } = usePostsStore();

    const filtersKey = useMemo(() => JSON.stringify(filters || {}), [filters]);
    const { user: currentUser, isAuthenticated } = useOxy();
    const isFetchingRef = useRef(false);
    const prefetchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const loadMoreDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const isLoadingMoreRef = useRef(false);

    const itemKey = useCallback((it: any): string => {
        // Try id first (should be string), then _id (could be ObjectId or string)
        let normalizedId = '';
        if (it?.id) {
            normalizedId = String(it.id);
        } else if (it?._id) {
            const _id = it._id;
            normalizedId = typeof _id === 'object' && _id.toString
                ? _id.toString()
                : String(_id);
        } else if (it?._id_str) {
            normalizedId = String(it._id_str);
        } else if (it?.postId) {
            normalizedId = String(it.postId);
        } else if (it?.post?.id) {
            normalizedId = String(it.post.id);
        } else if (it?.post?._id) {
            const _id = it.post._id;
            normalizedId = typeof _id === 'object' && _id.toString
                ? _id.toString()
                : String(_id);
        }

        if (normalizedId && normalizedId !== 'undefined' && normalizedId !== 'null' && normalizedId !== '') {
            return normalizedId;
        }

        const fallback = it?.username || JSON.stringify(it);
        return String(fallback);
    }, []);

    const previousReloadKeyRef = useRef<string | number | undefined>(undefined);

    const fetchInitialFeed = useCallback(async (forceRefresh: boolean = false) => {
        // Debounce rapid calls
        if (isFetchingRef.current) {
            logger.debug('[Feed] fetchInitialFeed: Already fetching, skipping');
            return;
        }

        // Set fetching flag immediately to prevent duplicate calls
        isFetchingRef.current = true;

        if (isAuthenticated && !currentUser?.id) {
            logger.debug('[Feed] fetchInitialFeed: Not authenticated, skipping');
            isFetchingRef.current = false;
            return;
        }

        // Check if feed already has items in the store
        const feedTypeToCheck = showOnlySaved ? 'saved' : type;
        const currentFeed = !useScoped ? usePostsStore.getState().feeds[feedTypeToCheck] : null;
        const hasItems = currentFeed?.items && currentFeed.items.length > 0;

        logger.debug('[Feed] fetchInitialFeed:', {
            forceRefresh,
            showOnlySaved,
            feedTypeToCheck,
            hasItems,
            filters: filters
        });

        // CRITICAL: Only fetch if:
        // 1. Force refresh (reloadKey changed - user pressed same tab)
        // 2. Feed doesn't have items (first time loading)
        // 3. Filters changed (for saved posts with search)
        // DO NOT fetch if just switching tabs and feed already has items
        // For saved posts, always fetch to support search filtering
        if (!useScoped && hasItems && !forceRefresh && !showOnlySaved && !filters?.searchQuery) {
            // Feed already loaded and user is just switching tabs - don't reload
            logger.debug('[Feed] fetchInitialFeed: Skipping - feed has items and not saved');
            return;
        }

        // For saved posts, always proceed to fetch (even if items exist) to support search filtering

        const shouldRefresh = forceRefresh;

        try {
            if (!useScoped) {
                clearError();
            } else {
                setLocalError(null);
            }

            if (showOnlySaved) {
                // Use feed endpoint with type='saved' and searchQuery filter
                // Always fetch saved posts to ensure fresh data and search filtering
                logger.debug('[Feed] fetchInitialFeed: Fetching saved posts with filters:', filters || {});
                await fetchFeed({ type: 'saved', limit: 50, filters: filters || {} });
                return;
            }

            if (useScoped) {
                setLocalLoading(true);
                setLocalError(null);
                const resp = await feedService.getFeed({ type, limit: 20, filters } as any);
                let items = resp.items || [];

                const pid = (filters || {}).postId || (filters || {}).parentPostId;
                if (pid) {
                    items = items.filter((it: any) => String(it.postId || it.parentPostId) === String(pid));
                }

                // Optimized deduplication using Set
                const seen = new Set<string>();
                const uniqueItems = items.filter((item: any) => {
                    const key = itemKey(item);
                    if (key && !seen.has(key)) {
                        seen.add(key);
                        return true;
                    }
                    return false;
                });

                setLocalItems(uniqueItems);
                setLocalHasMore(!!resp.hasMore);
                setLocalNextCursor(resp.nextCursor);
            } else if (userId) {
                await fetchUserFeed(userId, { type, limit: 20, filters });
            } else {
                if (shouldRefresh) {
                    await refreshFeed(type, filters);
                } else {
                    await fetchFeed({ type, limit: 20, filters });
                }
            }
        } catch (error) {
            logger.error('Feed: Error fetching initial feed', error);
            if (useScoped) {
                setLocalError('Failed to load');
            }
        } finally {
            if (useScoped) setLocalLoading(false);
            isFetchingRef.current = false;
        }
    }, [type, userId, showOnlySaved, useScoped, filters, filtersKey, reloadKey, isAuthenticated, currentUser?.id, fetchFeed, fetchUserFeed, refreshFeed, clearError, itemKey]);

    // Track reloadKey changes separately from type changes
    useEffect(() => {
        const reloadKeyChanged = previousReloadKeyRef.current !== undefined && previousReloadKeyRef.current !== reloadKey;
        previousReloadKeyRef.current = reloadKey;

        // If reloadKey changed, always refresh (user pressed same tab)
        if (reloadKeyChanged) {
            fetchInitialFeed(true); // Force refresh
        }
    }, [reloadKey, fetchInitialFeed]);

    // Handle initial load and type/filter changes
    useEffect(() => {
        logger.debug('[Feed] useEffect triggered:', {
            filtersKey,
            showOnlySaved,
            filters: filters
        });

        // Skip if reloadKey just changed (handled by above effect)
        const reloadKeyChanged = previousReloadKeyRef.current !== undefined && previousReloadKeyRef.current !== reloadKey;
        if (reloadKeyChanged) {
            logger.debug('[Feed] useEffect: Skipping - reloadKey changed');
            return; // Let the reloadKey effect handle it
        }

        // For saved posts, always fetch when filters change (search query)
        // For other feeds, check if feed already has items
        if (!useScoped && !showOnlySaved) {
            const feedTypeToCheck = type;
            const currentFeed = usePostsStore.getState().feeds[feedTypeToCheck];
            const hasItems = currentFeed?.items && currentFeed.items.length > 0;

            // If feed has items and no filters/search, skip fetching (just switching tabs)
            if (hasItems && !filters?.searchQuery) {
                logger.debug('[Feed] useEffect: Skipping - feed has items and no search query');
                return;
            }
        }

        // Feed doesn't have items yet or filters changed, fetch it
        // For saved posts, always fetch to support search filtering
        logger.debug('[Feed] useEffect: Calling fetchInitialFeed');
        fetchInitialFeed(false);
    }, [type, filtersKey, fetchInitialFeed, useScoped, reloadKey, showOnlySaved, filters]);

    const handleRefresh = useCallback(async () => {
        setRefreshing(true);
        try {
            if (!useScoped) {
                clearError();
            }

            if (showOnlySaved) {
                // Use feed endpoint with type='saved' and searchQuery filter
                await refreshFeed('saved', filters);
            } else if (useScoped) {
                try {
                    setLocalLoading(true);
                    setLocalError(null);
                    const resp = await feedService.getFeed({ type, limit: 20, filters } as any);
                    const items = resp.items || [];

                    // Optimized deduplication - store already handles most deduplication
                    // This is just a safety pass
                    const seen = new Set<string>();
                    const uniqueItems = items.filter((item: any) => {
                        const key = itemKey(item);
                        if (key && !seen.has(key)) {
                            seen.add(key);
                            return true;
                        }
                        return false;
                    });

                    setLocalItems(uniqueItems);
                    setLocalHasMore(!!resp.hasMore);
                    setLocalNextCursor(resp.nextCursor);
                } catch (error) {
                    logger.error('Error refreshing scoped feed', error);
                    setLocalError('Failed to refresh');
                } finally {
                    setLocalLoading(false);
                }
            } else if (userId) {
                await fetchUserFeed(userId, { type, limit: 20, filters });
            } else {
                await refreshFeed(type, filters);
            }
        } catch (error) {
            logger.error('Error refreshing feed', error);
            if (useScoped) {
                setLocalError('Failed to refresh');
            }
        } finally {
            setRefreshing(false);
        }
    }, [type, effectiveType, userId, showOnlySaved, refreshFeed, fetchUserFeed, filters, useScoped, clearError]);

    const handleLoadMore = useCallback(async () => {
        // CRITICAL: Use ref-based guard to prevent concurrent calls synchronously
        // State-based guards (isLoadingMore) are async and can allow race conditions
        if (isLoadingMoreRef.current) {
            logger.debug('[Feed] handleLoadMore: Already loading, skipping duplicate call');
            return;
        }

        if (showOnlySaved) {
            // Use feed endpoint for loading more saved posts
            isLoadingMoreRef.current = true;
            try {
                await loadMoreFeed('saved', filters);
            } finally {
                isLoadingMoreRef.current = false;
            }
            return;
        }

        // Check conditions before setting ref flag
        if (!hasMore || isLoading || isLoadingMore) return;

        // Set loading flag immediately to prevent concurrent calls
        isLoadingMoreRef.current = true;

        // Clear any pending debounce
        if (loadMoreDebounceRef.current) {
            clearTimeout(loadMoreDebounceRef.current);
            loadMoreDebounceRef.current = null;
        }

        setIsLoadingMore(true);
        try {
            if (useScoped) {
                if (!localHasMore || localLoading) {
                    // Reset ref flag before early return
                    isLoadingMoreRef.current = false;
                    setIsLoadingMore(false);
                    return;
                }
                setLocalLoading(true);
                setLocalError(null);

                const resp = await feedService.getFeed({
                    type,
                    limit: 20,
                    cursor: localNextCursor,
                    filters
                });

                let items = resp.items || [];
                const pid = (filters || {}).postId || (filters || {}).parentPostId;
                if (pid) {
                    items = items.filter((item: any) =>
                        String(item.postId || item.parentPostId) === String(pid)
                    );
                }

                // Optimized deduplication using Set for O(1) lookup
                setLocalItems(prev => {
                    const existingIds = new Set(prev.map(p => itemKey(p)));
                    const uniqueNew = items.filter((p: any) => {
                        const key = itemKey(p);
                        return key && !existingIds.has(key);
                    });
                    return prev.concat(uniqueNew);
                });

                const prevCursor = localNextCursor;
                const nextCursor = resp.nextCursor;
                const cursorAdvanced = !!nextCursor && nextCursor !== prevCursor;
                setLocalHasMore(!!resp.hasMore && cursorAdvanced);
                setLocalNextCursor(nextCursor);
            } else if (userId) {
                await fetchUserFeed(userId, {
                    type: effectiveType,
                    limit: 20,
                    cursor: feedData?.nextCursor,
                    filters
                });
            } else {
                await loadMoreFeed(effectiveType, filters);
            }
        } catch (err: unknown) {
            logger.error('Error loading more feed', err);
            let errorMessage = 'Failed to load more posts';
            if (err && typeof err === 'object' && 'message' in err && typeof (err as any).message === 'string') {
                errorMessage = (err as any).message;
            }
            if (useScoped) {
                setLocalError(errorMessage);
            }
        } finally {
            if (useScoped) {
                setLocalLoading(false);
            }
            setIsLoadingMore(false);
            // CRITICAL: Reset ref flag after operation completes
            isLoadingMoreRef.current = false;
        }
    }, [showOnlySaved, hasMore, isLoading, isLoadingMore, type, effectiveType, userId, loadMoreFeed, fetchUserFeed, feedData?.nextCursor, filters, useScoped, localHasMore, localLoading, localNextCursor, itemKey]);

    // Prefetch next page when approaching end (75% scroll)
    // NOTE: Disabled to prevent duplicate loads - onEndReached already handles this
    // Keeping callback for potential future use but not triggering loadMore
    const handleViewableItemsChanged = useCallback(({ viewableItems }: any) => {
        // Disabled to prevent duplicate triggers with onEndReached
        // onEndReached already handles loading more at the threshold
        return;
    }, []);

    // Cleanup timers on unmount
    useEffect(() => {
        return () => {
            if (prefetchTimerRef.current) {
                clearTimeout(prefetchTimerRef.current);
            }
            if (loadMoreDebounceRef.current) {
                clearTimeout(loadMoreDebounceRef.current);
            }
        };
    }, []);

    // Memoize renderPostItem to prevent recreating on every render
    // CRITICAL: Keep dependency array EMPTY - PostItem is memoized and will handle its own updates
    const renderPostItem = useCallback(({ item, index }: { item: any; index: number }) => {
        // Validate item before rendering to prevent crashes
        if (!item || !item.id) {
            logger.warn('[Feed] Invalid post item', item);
            return null;
        }

        // CRITICAL: Don't add key prop here - FlashList handles keys via keyExtractor
        // Adding a key prop can interfere with FlashList's recycling mechanism
        // PostItem is already memoized with arePropsEqual, so it will only rerender when needed
        return <PostItem post={item} />;
    }, []); // Empty deps - PostItem handles its own memoization

    // Optimize displayItems computation - use InteractionManager for heavy sorting
    const displayItems = useMemo(() => {
        const src = (useScoped ? localItems : (filteredFeedData?.items || [])) as any[];

        if (src.length === 0) return [];

        // Fast deduplication using Map for O(1) lookups
        const seen = new Map<string, any>();
        const duplicateIds: string[] = [];

        // Single pass deduplication - more efficient than multiple passes
        for (const item of src) {
            const id = normalizeId(item);
            if (id && id !== 'undefined' && id !== 'null' && id !== '') {
                if (!seen.has(id)) {
                    seen.set(id, item);
                } else {
                    duplicateIds.push(id);
                }
            }
        }

        const deduped = Array.from(seen.values());

        // Log duplicates in development only
        if (process.env.NODE_ENV === 'development' && duplicateIds.length > 0) {
            logger.error(`[Feed:displayItems] Found ${duplicateIds.length} duplicates in feed items`, {
                duplicates: [...new Set(duplicateIds)].slice(0, 10),
                feedType: effectiveType,
                totalItems: src.length,
                uniqueItems: deduped.length
            });
        }

        // Only apply sorting for 'for_you' feed if user is authenticated
        // Use InteractionManager to defer heavy sorting operations
        if (effectiveType === 'for_you' && currentUser?.id && deduped.length > 0) {
            const now = Date.now();
            const THRESHOLD_MS = 60 * 1000;
            const mineNow: any[] = [];
            const others: any[] = [];

            // Single pass to separate items
            for (const item of deduped) {
                const ownerId = item?.user?.id;
                if (item?.isLocalNew || (ownerId === currentUser.id)) {
                    const d = item?.date || item?.createdAt;
                    const ts = d ? Date.parse(d) : 0;
                    if (ts && (now - ts) <= THRESHOLD_MS) {
                        mineNow.push({ item, ts });
                    } else {
                        others.push(item);
                    }
                } else {
                    others.push(item);
                }
            }

            // Sort only if we have recent items from user
            if (mineNow.length > 0) {
                mineNow.sort((a, b) => b.ts - a.ts);
                return [...mineNow.map(x => x.item), ...others];
            }
        }

        return deduped;
    }, [useScoped, localItems, filteredFeedData?.items, effectiveType, currentUser?.id]);

    const renderEmptyState = useCallback(() => {
        if (isLoading) return null;

        const hasError = error || (useScoped && localError);
        const hasNoItems = displayItems.length === 0;

        if (hasError && hasNoItems) {
            const handleRetry = async () => {
                clearError();
                if (useScoped) setLocalError(null);
                try {
                    if (showOnlySaved) {
                        await fetchFeed({ type: 'saved', limit: 50, filters: filters || {} });
                    } else if (userId) {
                        await fetchUserFeed(userId, { type, limit: 20, filters });
                    } else {
                        await fetchFeed({ type: effectiveType, limit: 20, filters });
                    }
                } catch (retryError) {
                    logger.error('Retry failed', retryError);
                }
            };

            return (
                <Error
                    title="Failed to load posts"
                    message="Unable to fetch posts. Please check your connection and try again."
                    onRetry={handleRetry}
                    hideBackButton={true}
                    style={{ flex: 1, paddingVertical: 60 }}
                />
            );
        }

        return (
            <View style={flattenStyleArray([styles.emptyState, { backgroundColor: theme.colors.background }])}>
                <Text style={flattenStyleArray([styles.emptyStateText, { color: theme.colors.text }])}>
                    {showOnlySaved ? 'No saved posts yet' : 'No posts yet'}
                </Text>
                <Text style={flattenStyleArray([styles.emptyStateSubtext, { color: theme.colors.textSecondary }])}>
                    {showOnlySaved
                        ? 'Posts you save will appear here. Tap the bookmark icon on any post to save it.'
                        : type === 'posts' ? 'Be the first to share something!' :
                            type === 'media' ? 'No media posts found' :
                                type === 'replies' ? 'No replies yet' :
                                    type === 'reposts' ? 'No reposts yet' :
                                        type === 'explore' ? 'No trending posts right now. Check back later!' :
                                            type === 'following' ? 'Start following people to see their posts' :
                                                type === 'for_you' ? 'Discover posts based on your interests' :
                                                    type === 'custom' ? 'This feed is empty' :
                                                        'Start following people to see their posts'}
                </Text>
            </View>
        );
    }, [isLoading, error, localError, useScoped, type, effectiveType, userId, clearError, fetchFeed, fetchUserFeed, showOnlySaved, displayItems.length, filters, theme.colors.background, theme.colors.error, theme.colors.primary, theme.colors.shadow, theme.colors.card, theme.colors.text, theme.colors.textSecondary]);

    const renderFooter = useCallback(() => {
        if (showOnlySaved || !hasMore || !isLoadingMore) return null;

        const hasItems = useScoped ? (localItems.length > 0) : !!(filteredFeedData?.items && filteredFeedData.items.length > 0);
        if (!hasItems) return null;

        return (
            <View style={styles.footer}>
                <ActivityIndicator size="small" color={theme.colors.primary} />
            </View>
        );
    }, [showOnlySaved, hasMore, isLoadingMore, filteredFeedData?.items, useScoped, localItems.length, theme.colors.primary]);

    const renderHeader = useCallback(() => {
        if (!showComposeButton || hideHeader) return null;

        return (
            <View style={flattenStyleArray([{ backgroundColor: theme.colors.background }])}>
                <TouchableOpacity
                    style={flattenStyleArray([styles.composeButton, { backgroundColor: theme.colors.backgroundSecondary, borderColor: theme.colors.border, shadowColor: theme.colors.shadow }])}
                    onPress={onComposePress}
                >
                    <Text style={flattenStyleArray([styles.composeButtonText, { color: theme.colors.textSecondary }])}>What&apos;s happening?</Text>
                </TouchableOpacity>
            </View>
        );
    }, [showComposeButton, onComposePress, hideHeader, theme.colors.background, theme.colors.backgroundSecondary, theme.colors.border, theme.colors.shadow, theme.colors.textSecondary]);

    const keyExtractor = useCallback((item: any) => itemKey(item), [itemKey]);

    // CRITICAL: getItemType helps FlashList properly recycle components
    // All posts use the same type, but this helps FlashList optimize recycling
    const getItemType = useCallback((item: any) => {
        // Return item type based on post structure to help FlashList recycle correctly
        if (item?.original || item?.repostOf) return 'repost';
        if (item?.quoted || item?.quoteOf) return 'quote';
        if (item?.parentPostId || item?.replyTo) return 'reply';
        return 'post'; // Default type
    }, []);

    // Optimized data hash - only recalculate when items actually change
    const dataHash = useMemo(() => {
        const count = displayItems.length;
        if (count === 0) return 'empty';
        // Use first few and last few IDs for hash - faster than all items
        const firstKey = itemKey(displayItems[0]);
        const lastKey = itemKey(displayItems[count - 1]);
        // Include count and a few middle items for better uniqueness
        const midKey = count > 2 ? itemKey(displayItems[Math.floor(count / 2)]) : '';
        return `${count}-${firstKey}-${midKey}-${lastKey}`;
    }, [displayItems.length, displayItems, itemKey]);

    // Final deduplication layer - optimized using Map for better performance
    const finalRenderItems = useMemo(() => {
        if (displayItems.length === 0) return [];

        // Use Map instead of Set + Array for single-pass deduplication
        const seen = new Map<string, any>();
        for (const item of displayItems) {
            const key = itemKey(item);
            if (key && !seen.has(key)) {
                seen.set(key, item);
            }
        }
        return Array.from(seen.values());
    }, [displayItems, itemKey]);

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
        if (scrollEnabled === false) return;
        if (node) {
            unregisterScrollableRef.current = registerScrollable(node);
        }
    }, [clearScrollableRegistration, registerScrollable, scrollEnabled]);

    useEffect(() => {
        if (scrollEnabled === false) {
            clearScrollableRegistration();
            return;
        }
        if (flatListRef.current && !unregisterScrollableRef.current) {
            unregisterScrollableRef.current = registerScrollable(flatListRef.current);
        }
    }, [clearScrollableRegistration, registerScrollable, scrollEnabled]);

    useEffect(() => () => {
        clearScrollableRegistration();
    }, [clearScrollableRegistration]);

    // Handle scroll events
    const handleScrollEvent = useCallback((event: any) => {
        if (scrollEnabled !== false && handleScroll) {
            handleScroll(event);
        }
    }, [handleScroll, scrollEnabled]);

    // Handle wheel events
    const handleWheelEvent = useCallback((event: any) => {
        if (forwardWheelEvent) {
            forwardWheelEvent(event);
        }
    }, [forwardWheelEvent]);

    // Web-specific dataSet for scroll detection
    const dataSetForWeb = useMemo(() => {
        if (Platform.OS !== 'web') return undefined;
        return { layoutscroll: 'true' };
    }, []);

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

    // Memoize container style
    const containerStyle = useMemo(() =>
        flattenStyleArray([styles.container, { backgroundColor: theme.colors.background }]),
        [theme.colors.background]
    );

    // Memoize list content style
    const listContentStyle = useMemo(() =>
        flattenStyleArray([
            styles.listContent,
            { backgroundColor: theme.colors.background },
            contentContainerStyle,
        ]),
        [theme.colors.background, contentContainerStyle]
    );

    // Memoize list style
    const listStyle = useMemo(() =>
        flattenStyleArray([
            styles.list,
            { backgroundColor: theme.colors.background },
            style,
        ]),
        [theme.colors.background, style]
    );

    return (
        <ErrorBoundary>
            <View
                style={containerStyle}
                {...(Platform.OS === 'web' && dataSetForWeb ? { 'data-layoutscroll': 'true' } : {})}
            >
                <LoadingTopSpinner showLoading={isLoading && !refreshing && !isLoadingMore && displayItems.length === 0} />
                <FlashList
                    ref={assignListRef}
                    data={finalRenderItems}
                    renderItem={renderPostItem}
                    keyExtractor={keyExtractor}
                    getItemType={getItemType}
                    {...({
                        estimatedItemSize: 250,
                        extraData: dataHash,
                        ListHeaderComponent: listHeaderComponent ?? renderHeader,
                        ListEmptyComponent: renderEmptyState,
                        ListFooterComponent: renderFooter,
                        scrollEnabled: scrollEnabled,
                        refreshControl: refreshControl,
                        onEndReached: handleLoadMore,
                        onEndReachedThreshold: 0.7,
                        showsVerticalScrollIndicator: false,
                        onScroll: scrollEnabled === false ? undefined : handleScrollEvent,
                        scrollEventThrottle: scrollEnabled === false ? undefined : scrollEventThrottle,
                        onWheel: Platform.OS === 'web' ? handleWheelEvent : undefined,
                        contentContainerStyle: listContentStyle,
                        style: listStyle,
                        // Performance optimizations for FlashList
                        drawDistance: 600, // Increased for smoother scrolling
                        removeClippedSubviews: true, // Remove off-screen views to save memory
                        maxToRenderPerBatch: 10, // Balanced for smooth scrolling and fast loading
                        windowSize: 10, // Larger window for smoother scrolling
                        initialNumToRender: 12, // Faster initial render with more items
                        updateCellsBatchingPeriod: 50, // More frequent batching for smoother updates
                        disableAutoLayout: false, // Let FlashList handle layout automatically
                        overrideItemLayout: (layout: any, item: any, index: number) => {
                            // Provide layout hints for better performance
                            layout.size = 250; // Estimated item size
                        },
                    } as any)}
                />
            </View>
        </ErrorBoundary>
    );
};

// Custom comparison function to prevent unnecessary re-renders
const arePropsEqual = (prevProps: FeedProps, nextProps: FeedProps) => {
    // Always rerender if reloadKey changes (user pressed same tab)
    if (prevProps.reloadKey !== nextProps.reloadKey) {
        return false;
    }

    // Rerender if feed type changed
    if (prevProps.type !== nextProps.type) {
        return false;
    }

    // Rerender if userId changed
    if (prevProps.userId !== nextProps.userId) {
        return false;
    }

    // Rerender if filters changed (deep comparison)
    const prevFilters = JSON.stringify(prevProps.filters || {});
    const nextFilters = JSON.stringify(nextProps.filters || {});
    if (prevFilters !== nextFilters) {
        return false;
    }

    // Rerender if showOnlySaved changed
    if (prevProps.showOnlySaved !== nextProps.showOnlySaved) {
        return false;
    }

    // Rerender if scrollEnabled changed
    if (prevProps.scrollEnabled !== nextProps.scrollEnabled) {
        return false;
    }

    // Props are equal, skip re-render
    return true;
};

export default React.memo(Feed, arePropsEqual);

const styles = StyleSheet.create({
    container: {
        flex: 1,
        minHeight: 0,
    },
    list: {
        flex: 1,
        minHeight: 0,
    },
    listContent: {
        flexGrow: 0,
        alignSelf: 'stretch',
    },
    emptyState: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        paddingVertical: 80,
        paddingHorizontal: 32,
    },
    emptyStateText: {
        fontSize: 20,
        fontWeight: '700',
        marginTop: 24,
        textAlign: 'center',
        letterSpacing: -0.5,
    },
    emptyStateSubtext: {
        fontSize: 16,
        marginTop: 12,
        textAlign: 'center',
        lineHeight: 24,
        maxWidth: 280,
    },
    errorText: {
        fontSize: 16,
        marginBottom: 20,
        textAlign: 'center',
        fontWeight: '500',
    },
    retryButton: {
        paddingHorizontal: 28,
        paddingVertical: 14,
        borderRadius: 24,
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.1,
        shadowRadius: 4,
        elevation: 3,
    },
    retryButtonText: {
        fontSize: 16,
        fontWeight: '600',
    },
    footer: {
        flexDirection: 'row',
        justifyContent: 'center',
        alignItems: 'center',
        paddingVertical: 8,
    },
    footerText: {
        fontSize: 14,
        fontWeight: '500',
    },
    composeButton: {
        marginHorizontal: 16,
        marginVertical: 12,
        padding: 16,
        borderRadius: 12,
        borderWidth: 1,
        shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.05,
        shadowRadius: 2,
        elevation: 1,
    },
    composeButtonText: {
        fontSize: 16,
        fontWeight: '400',
    },
});
