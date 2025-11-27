import { useState, useCallback, useRef, useEffect } from 'react';
import { FeedType } from '@mention/shared-types';
import { usePostsStore, useFeedSelector, useUserFeedSelector } from '@/stores/postsStore';

// FeedItem type matches what the store returns (UIPost-like structure)
type FeedItem = any; // Store returns items that match PostItem's expected types
import { feedService } from '@/services/feedService';
import { FeedFilters, getItemKey, deduplicateItems } from '@/utils/feedUtils';
import { createScopedLogger } from '@/utils/logger';
import { useDeepCompareEffect } from './useDeepCompare';

const logger = createScopedLogger('useFeedState');

export interface UseFeedStateOptions {
    type: FeedType;
    userId?: string;
    showOnlySaved?: boolean;
    filters?: FeedFilters;
    useScoped?: boolean;
    reloadKey?: string | number;
    isAuthenticated?: boolean;
    currentUserId?: string;
}

export interface UseFeedStateReturn {
    // Feed data
    items: FeedItem[];
    hasMore: boolean;
    isLoading: boolean;
    error: string | null;
    nextCursor?: string;
    
    // Actions
    fetchInitial: (forceRefresh?: boolean) => Promise<void>;
    refresh: () => Promise<void>;
    loadMore: () => Promise<void>;
    clearError: () => void;
}

/**
 * Custom hook for managing feed state and fetching
 * Handles both scoped (local) and global feed state
 */
export function useFeedState({
    type,
    userId,
    showOnlySaved,
    filters,
    useScoped,
    reloadKey,
    isAuthenticated,
    currentUserId,
}: UseFeedStateOptions): UseFeedStateReturn {
    const {
        fetchFeed,
        fetchUserFeed,
        refreshFeed,
        loadMoreFeed,
        clearError: clearGlobalError,
    } = usePostsStore();

    // Local state for scoped feeds
    const [localItems, setLocalItems] = useState<FeedItem[]>([]);
    const [localHasMore, setLocalHasMore] = useState<boolean>(true);
    const [localNextCursor, setLocalNextCursor] = useState<string | undefined>(undefined);
    const [localLoading, setLocalLoading] = useState<boolean>(false);
    const [localError, setLocalError] = useState<string | null>(null);

    // Global feed state - use exported selectors for consistency
    const effectiveType = (showOnlySaved ? 'saved' : type) as FeedType;
    const globalFeedSelector = useFeedSelector(effectiveType);
    const userFeedSelector = useUserFeedSelector(userId || '', effectiveType);
    const globalFeed = showOnlySaved ? globalFeedSelector : (userId ? userFeedSelector : globalFeedSelector);

    // Refs for preventing duplicate calls
    const isFetchingRef = useRef(false);
    const isLoadingMoreRef = useRef(false);
    const abortControllerRef = useRef<AbortController | null>(null);
    const previousReloadKeyRef = useRef<string | number | undefined>(undefined);

    // Cleanup abort controller on unmount
    useEffect(() => {
        return () => {
            if (abortControllerRef.current) {
                abortControllerRef.current.abort();
            }
        };
    }, []);

    const clearError = useCallback(() => {
        if (useScoped) {
            setLocalError(null);
        } else {
            clearGlobalError();
        }
    }, [useScoped, clearGlobalError]);

    const fetchInitial = useCallback(
        async (forceRefresh: boolean = false) => {
            // Prevent duplicate calls
            if (isFetchingRef.current) {
                logger.debug('[useFeedState] Already fetching, skipping');
                return;
            }

            isFetchingRef.current = true;

            // Cancel previous request if still pending
            if (abortControllerRef.current) {
                abortControllerRef.current.abort();
            }

            // Create new abort controller
            abortControllerRef.current = new AbortController();
            const signal = abortControllerRef.current.signal;

            if (isAuthenticated && !currentUserId) {
                logger.debug('[useFeedState] Not authenticated, skipping');
                isFetchingRef.current = false;
                return;
            }

            const feedTypeToCheck = showOnlySaved ? 'saved' : type;
            const currentFeed = !useScoped ? usePostsStore.getState().feeds[feedTypeToCheck] : null;
            const hasItems = currentFeed?.items && currentFeed.items.length > 0;

            // Skip if feed already has items and not forcing refresh
            if (!useScoped && hasItems && !forceRefresh && !showOnlySaved && !filters?.searchQuery) {
                logger.debug('[useFeedState] Skipping - feed has items and not saved');
                isFetchingRef.current = false;
                return;
            }

            try {
                clearError();

                if (showOnlySaved) {
                    await fetchFeed({ type: 'saved', limit: 50, filters: filters || {} });
                    return;
                }

                if (useScoped) {
                    setLocalLoading(true);
                    setLocalError(null);

                    const resp = await feedService.getFeed(
                        { type, limit: 20, filters } as any,
                        { signal }
                    );

                    if (signal.aborted) return;

                    let items = resp.items || [];
                    const pid = filters?.postId || filters?.parentPostId;
                    if (pid) {
                        items = items.filter(
                            (it: any) => String(it.postId || it.parentPostId) === String(pid)
                        );
                    }

                    const uniqueItems = deduplicateItems(items, getItemKey);
                    setLocalItems(uniqueItems);
                    setLocalHasMore(!!resp.hasMore);
                    setLocalNextCursor(resp.nextCursor);
                } else if (userId) {
                    await fetchUserFeed(userId, { type, limit: 20, filters });
                } else {
                    if (forceRefresh) {
                        await refreshFeed(type, filters);
                    } else {
                        await fetchFeed({ type, limit: 20, filters });
                    }
                }
            } catch (err: unknown) {
                if (signal.aborted) {
                    logger.debug('[useFeedState] Request aborted');
                    return;
                }

                logger.error('[useFeedState] Error fetching feed', err);
                if (useScoped) {
                    setLocalError('Failed to load');
                }
            } finally {
                if (useScoped) setLocalLoading(false);
                isFetchingRef.current = false;
            }
        },
        [
            type,
            userId,
            showOnlySaved,
            useScoped,
            isAuthenticated,
            currentUserId,
            filters,
            fetchFeed,
            fetchUserFeed,
            refreshFeed,
            clearError,
        ]
    );

    const refresh = useCallback(async () => {
        if (abortControllerRef.current) {
            abortControllerRef.current.abort();
        }

        abortControllerRef.current = new AbortController();
        const signal = abortControllerRef.current.signal;

        try {
            clearError();

            if (showOnlySaved) {
                await refreshFeed('saved', filters);
                return;
            }

            if (useScoped) {
                setLocalLoading(true);
                setLocalError(null);

                const resp = await feedService.getFeed(
                    { type, limit: 20, filters } as any,
                    { signal }
                );

                if (signal.aborted) return;

                // Filter and deduplicate items
                let items = resp.items || [];
                const pid = filters?.postId || filters?.parentPostId;
                if (pid) {
                    items = items.filter(
                        (it: any) => String(it.postId || it.parentPostId) === String(pid)
                    );
                }

                setLocalItems(deduplicateItems(items, getItemKey));
                setLocalHasMore(!!resp.hasMore);
                setLocalNextCursor(resp.nextCursor);
            } else if (userId) {
                await fetchUserFeed(userId, { type, limit: 20, filters });
            } else {
                await refreshFeed(type, filters);
            }
        } catch (err: unknown) {
            if (signal.aborted) return;

            logger.error('[useFeedState] Error refreshing feed', err);
            if (useScoped) {
                setLocalError('Failed to refresh');
            }
        } finally {
            if (useScoped) setLocalLoading(false);
        }
    }, [type, userId, showOnlySaved, useScoped, filters, refreshFeed, fetchUserFeed, clearError]);

    const loadMore = useCallback(async () => {
        if (isLoadingMoreRef.current) {
            logger.debug('[useFeedState] Already loading more, skipping');
            return;
        }

        if (abortControllerRef.current) {
            abortControllerRef.current.abort();
        }

        abortControllerRef.current = new AbortController();
        const signal = abortControllerRef.current.signal;

        isLoadingMoreRef.current = true;

        try {
            if (showOnlySaved) {
                await loadMoreFeed('saved', filters);
                return;
            }

            if (useScoped) {
                if (!localHasMore || localLoading) {
                    isLoadingMoreRef.current = false;
                    return;
                }

                setLocalLoading(true);
                setLocalError(null);

                const resp = await feedService.getFeed(
                    { type, limit: 20, cursor: localNextCursor, filters } as any,
                    { signal }
                );

                if (signal.aborted) return;

                let items = resp.items || [];
                const pid = filters?.postId || filters?.parentPostId;
                if (pid) {
                    items = items.filter(
                        (it: any) => String(it.postId || it.parentPostId) === String(pid)
                    );
                }

                // Deduplicate against existing items - O(n) with Set lookup
                setLocalItems((prev) => {
                    const existingIds = new Set(prev.map(getItemKey));
                    const uniqueNew = deduplicateItems(items, getItemKey).filter(
                        (p) => !existingIds.has(getItemKey(p))
                    );
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
                    cursor: globalFeed?.nextCursor,
                    filters,
                });
            } else {
                await loadMoreFeed(effectiveType, filters);
            }
        } catch (err: unknown) {
            if (signal.aborted) {
                logger.debug('[useFeedState] Load more aborted');
                return;
            }

            logger.error('[useFeedState] Error loading more', err);
            if (useScoped) {
                let errorMessage = 'Failed to load more posts';
                if (err && typeof err === 'object' && 'message' in err && typeof (err as any).message === 'string') {
                    errorMessage = (err as any).message;
                }
                setLocalError(errorMessage);
            }
        } finally {
            if (useScoped) setLocalLoading(false);
            isLoadingMoreRef.current = false;
        }
    }, [
        showOnlySaved,
        useScoped,
        localHasMore,
        localLoading,
        localNextCursor,
        type,
        effectiveType,
        userId,
        filters,
        globalFeed?.nextCursor,
        loadMoreFeed,
        fetchUserFeed,
    ]);

    // Handle reloadKey changes - force refresh when user presses same tab
    useDeepCompareEffect(() => {
        const reloadKeyChanged =
            previousReloadKeyRef.current !== undefined && previousReloadKeyRef.current !== reloadKey;
        previousReloadKeyRef.current = reloadKey;

        if (reloadKeyChanged) {
            fetchInitial(true);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [reloadKey]); // Only depend on reloadKey to avoid unnecessary re-runs

    // Handle initial load and filter changes - skip if feed already has items
    useDeepCompareEffect(() => {
        const reloadKeyChanged =
            previousReloadKeyRef.current !== undefined && previousReloadKeyRef.current !== reloadKey;
        if (reloadKeyChanged) return; // Let reloadKey effect handle it

        if (!useScoped && !showOnlySaved) {
            const feedTypeToCheck = type;
            const currentFeed = usePostsStore.getState().feeds[feedTypeToCheck];
            const hasItems = currentFeed?.items && currentFeed.items.length > 0;

            if (hasItems && !filters?.searchQuery) {
                logger.debug('[useFeedState] Skipping - feed has items and no search query');
                return;
            }
        }

        fetchInitial(false);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [type, filters, useScoped, showOnlySaved]); // Removed reloadKey and fetchInitial from deps to reduce re-runs

    // Return appropriate state based on scoped vs global
    const items = useScoped ? localItems : globalFeed?.items || [];
    const hasMore = useScoped ? localHasMore : !!globalFeed?.hasMore;
    const isLoading = useScoped ? localLoading : !!globalFeed?.isLoading;
    const error = useScoped ? localError : globalFeed?.error || null;
    const nextCursor = useScoped ? localNextCursor : globalFeed?.nextCursor;

    return {
        items,
        hasMore,
        isLoading,
        error,
        nextCursor,
        fetchInitial,
        refresh,
        loadMore,
        clearError,
    };
}

