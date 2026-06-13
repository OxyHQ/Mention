import { useState, useCallback, useRef, useEffect } from 'react';
import { FeedType, FeedPostSlice, FeedRequest, HydratedPost } from '@mention/shared-types';
import { usePostsStore, useFeedSelector, useUserFeedSelector } from '@/stores/postsStore';
import { feedService } from '@/services/feedService';
import { FeedFilters, getItemKey, deduplicateItems } from '@/utils/feedUtils';
import { createScopedLogger } from '@/lib/logger';
import { useDeepCompareEffect } from './useDeepCompare';
import { buildFeedKey, hasFeedData, isDbAvailable } from '@/db';
import { resolveUseMemoryFeed } from '@/utils/feedMemoryMode';
import { precacheActorsFromPosts } from '@/lib/precacheActorsFromPosts';

// Re-export so callers that already imported from here keep working.
export { resolveUseMemoryFeed } from '@/utils/feedMemoryMode';

const logger = createScopedLogger('useFeedState');

// Retry configuration
const MAX_RETRIES = 3;
const BASE_RETRY_DELAY = 1000;

// Federated outbox-sync polling: when a profile feed responds with `pending`
// (its ActivityPub outbox is still syncing in the background), we refetch a few
// times until posts arrive, then stop. Bounded so we never poll indefinitely.
const FED_PENDING_POLL_INTERVAL_MS = 2500;
const FED_PENDING_MAX_POLLS = 3;

async function withRetry<T>(
    fn: () => Promise<T>,
    options: {
        maxRetries?: number;
        baseDelay?: number;
        signal?: AbortSignal;
        onRetry?: (attempt: number, error: unknown) => void;
    } = {}
): Promise<T> {
    const { maxRetries = MAX_RETRIES, baseDelay = BASE_RETRY_DELAY, signal, onRetry } = options;
    let lastError: unknown;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            if (signal?.aborted) throw new Error('Request aborted');
            return await fn();
        } catch (error) {
            lastError = error;
            if (signal?.aborted) throw error;
            if (attempt === maxRetries) throw error;
            if (error instanceof Error && error.message.includes('4')) throw error;
            onRetry?.(attempt + 1, error);
            const delay = baseDelay * Math.pow(2, attempt) + Math.random() * 500;
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
    throw lastError;
}

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
    items: HydratedPost[];
    slices?: FeedPostSlice[];
    hasMore: boolean;
    isLoading: boolean;
    error: string | null;
    nextCursor?: string;
    /**
     * True while a federated profile feed is still populating in the background
     * (the hook is auto-refetching). Consumers can show a brief loading state.
     */
    pending: boolean;
    fetchInitial: (forceRefresh?: boolean) => Promise<void>;
    refresh: () => Promise<void>;
    loadMore: () => Promise<void>;
    clearError: () => void;
}

/**
 * Custom hook for managing feed state and fetching.
 *
 * Memory mode (useMemoryFeed): activated when `useScoped` is true (filtered feeds)
 * OR when SQLite is unavailable (e.g. web without COOP/COEP headers, where
 * SharedArrayBuffer is undefined). In memory mode, items live in local React state
 * and are fetched directly via feedService. Pagination and refresh work identically
 * to the SQLite path.
 *
 * SQLite mode: activated when `isDbAvailable()` is true and no scoped filters are
 * present. Items are written to SQLite by postsStore and read back via selectors.
 * This is the native path and must remain byte-identical to the previous behavior.
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
    const [localItems, setLocalItems] = useState<HydratedPost[]>([]);
    const [localSlices, setLocalSlices] = useState<FeedPostSlice[] | undefined>(undefined);
    const [localHasMore, setLocalHasMore] = useState<boolean>(true);
    const [localNextCursor, setLocalNextCursor] = useState<string | undefined>(undefined);
    const [localLoading, setLocalLoading] = useState<boolean>(false);
    const [localError, setLocalError] = useState<string | null>(null);

    // Federated outbox-sync polling state. `pending` is surfaced to consumers so
    // the UI can show a "loading posts…" state; the scheduler refetches a bounded
    // number of times until posts arrive (or the budget is exhausted).
    const [pending, setPending] = useState<boolean>(false);
    const pendingPollCountRef = useRef<number>(0);
    const pendingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const clearPendingPoll = useCallback(() => {
        if (pendingTimerRef.current) {
            clearTimeout(pendingTimerRef.current);
            pendingTimerRef.current = null;
        }
    }, []);

    // Global feed state — reads from SQLite via selectors
    const effectiveType = (showOnlySaved ? 'saved' : type) as FeedType;
    const globalFeedSelector = useFeedSelector(effectiveType);
    const userFeedSelector = useUserFeedSelector(userId || '', effectiveType);
    const globalFeed = showOnlySaved ? globalFeedSelector : (userId ? userFeedSelector : globalFeedSelector);

    // useMemoryFeed is true when:
    //   1. useScoped is set (filtered/scoped feed — always uses local state), OR
    //   2. SQLite is unavailable (web without COOP/COEP, SharedArrayBuffer undefined)
    // When true, all feed items live in local React state (localItems/localNextCursor/…).
    // When false (SQLite available, no filters), items live in SQLite and are read via
    // selectors — this is the standard native path.
    const useMemoryFeed = resolveUseMemoryFeed(useScoped, isDbAvailable());

    // Refs for preventing duplicate calls
    const isFetchingRef = useRef(false);
    const isLoadingMoreRef = useRef(false);
    const abortControllerRef = useRef<AbortController | null>(null);
    const previousReloadKeyRef = useRef<string | number | undefined>(undefined);

    useEffect(() => {
        return () => {
            if (abortControllerRef.current) {
                abortControllerRef.current.abort();
            }
            clearPendingPoll();
        };
    }, [clearPendingPoll]);

    const clearError = useCallback(() => {
        if (useMemoryFeed) {
            setLocalError(null);
        } else {
            clearGlobalError();
        }
    }, [useMemoryFeed, clearGlobalError]);

    // Holds the latest `fetchInitial` so the pending-poll scheduler can re-invoke
    // it without creating a circular callback dependency.
    const fetchInitialRef = useRef<((forceRefresh?: boolean) => Promise<void>) | null>(null);

    // Apply a federated-pending result: surface the flag and, if posts are still
    // empty and we have polls left in our budget, schedule a bounded refetch.
    // Stops as soon as posts arrive or the budget is exhausted.
    const applyPendingResult = useCallback((isPending: boolean, hasItems: boolean) => {
        if (isPending && !hasItems) {
            setPending(true);
            if (pendingPollCountRef.current < FED_PENDING_MAX_POLLS) {
                clearPendingPoll();
                pendingTimerRef.current = setTimeout(() => {
                    pendingPollCountRef.current += 1;
                    fetchInitialRef.current?.(true);
                }, FED_PENDING_POLL_INTERVAL_MS);
            } else {
                logger.debug('Pending poll budget exhausted, showing empty state');
            }
        } else {
            // Posts arrived (or no longer pending) — stop polling and reset.
            clearPendingPoll();
            pendingPollCountRef.current = 0;
            setPending(false);
        }
    }, [clearPendingPoll]);

    const fetchInitial = useCallback(
        async (forceRefresh: boolean = false) => {
            if (isFetchingRef.current) {
                logger.debug('Already fetching, skipping');
                return;
            }

            isFetchingRef.current = true;

            if (abortControllerRef.current) {
                abortControllerRef.current.abort();
            }
            abortControllerRef.current = new AbortController();
            const signal = abortControllerRef.current.signal;

            if (isAuthenticated && !currentUserId) {
                logger.debug('Not authenticated, skipping');
                isFetchingRef.current = false;
                return;
            }

            const feedTypeToCheck = showOnlySaved ? 'saved' : type;

            // Check SQLite for cached data (cold-start optimization).
            // Only relevant when using the SQLite path (useMemoryFeed === false).
            if (!useMemoryFeed && !forceRefresh && !showOnlySaved && !filters?.searchQuery) {
                const feedKey = userId
                    ? buildFeedKey(feedTypeToCheck, userId)
                    : buildFeedKey(feedTypeToCheck);

                // If SQLite has items AND the UI state shows it was previously fetched
                const ui = usePostsStore.getState().feedUI[feedKey];
                const hasDbData = hasFeedData(feedKey);

                if (hasDbData && ui?.lastUpdated && ui.lastUpdated > 0) {
                    logger.debug('Skipping — feed has SQLite cache');
                    isFetchingRef.current = false;
                    return;
                }

                // SQLite has data from a previous session but no UI state yet
                // Show cached data immediately, then fetch fresh in background
                if (hasDbData && !ui?.lastUpdated) {
                    logger.debug('Cold start — showing SQLite cache, fetching in background');
                    isFetchingRef.current = false;
                    // Trigger background refresh without blocking
                    if (userId) {
                        fetchUserFeed(userId, { type, limit: 20, filters });
                    } else {
                        fetchFeed({ type, limit: 20, filters });
                    }
                    return;
                }
            }

            try {
                clearError();

                if (showOnlySaved) {
                    await fetchFeed({ type: 'saved', limit: 50, filters: filters || {} });
                    return;
                }

                if (useMemoryFeed) {
                    setLocalLoading(true);
                    setLocalError(null);

                    const feedReq: FeedRequest = { type, limit: 20, filters };
                    const resp = await withRetry(
                        () => userId
                            ? feedService.getUserFeed(userId, feedReq)
                            : feedService.getFeed({ type, limit: 20, filters }, { signal, skipCache: forceRefresh }),
                        {
                            signal,
                            onRetry: (attempt) => {
                                logger.debug(`Retrying feed request (attempt ${attempt})`);
                            },
                        }
                    );

                    if (signal.aborted) return;

                    let items = resp.items || [];
                    // When scoped (filtered), narrow results to the requested post/thread.
                    // For global-in-memory feeds (no filters), this guard is a no-op.
                    const pid = filters?.postId || filters?.parentPostId;
                    if (pid) {
                        items = items.filter(
                            (it: any) => String(it.postId || it.parentPostId) === String(pid)
                        );
                    }

                    const uniqueItems = deduplicateItems(items, getItemKey);
                    // Prime the React Query actor cache so avatars/names render
                    // on web (no SQLite). This is the web feed's only actor source.
                    precacheActorsFromPosts(uniqueItems);
                    setLocalItems(uniqueItems);
                    setLocalSlices(resp.slices || undefined);
                    setLocalHasMore(!!resp.hasMore);
                    setLocalNextCursor(resp.nextCursor);

                    // Federated profile feed still syncing → schedule a bounded refetch.
                    if (userId) {
                        applyPendingResult(resp.pending === true, uniqueItems.length > 0);
                    }
                } else if (userId) {
                    const { pending: isPending } = await fetchUserFeed(userId, { type, limit: 20, filters });
                    if (signal.aborted) return;
                    // Federated profile feed still syncing → schedule a bounded refetch.
                    // `fetchUserFeed` already reports `pending` only when items are empty.
                    applyPendingResult(isPending, !isPending);
                } else {
                    if (forceRefresh) {
                        await refreshFeed(type, filters);
                    } else {
                        await fetchFeed({ type, limit: 20, filters });
                    }
                }
            } catch (err: unknown) {
                if (signal.aborted) {
                    logger.debug('Request aborted');
                    return;
                }
                logger.error('Error fetching feed', { error: err });
                if (useMemoryFeed) {
                    setLocalError('Failed to load');
                }
            } finally {
                if (useMemoryFeed) setLocalLoading(false);
                isFetchingRef.current = false;
            }
        },
        [
            type,
            userId,
            showOnlySaved,
            useMemoryFeed,
            isAuthenticated,
            currentUserId,
            filters,
            fetchFeed,
            fetchUserFeed,
            refreshFeed,
            clearError,
            applyPendingResult,
        ]
    );

    // Keep the ref pointing at the latest fetchInitial for the pending-poll scheduler.
    fetchInitialRef.current = fetchInitial;

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

            if (useMemoryFeed) {
                setLocalLoading(true);
                setLocalError(null);

                const feedReq: FeedRequest = { type, limit: 20, filters };
                const resp = await withRetry(
                    () => userId
                        ? feedService.getUserFeed(userId, feedReq)
                        : feedService.getFeed({ type, limit: 20, filters }, { signal, skipCache: true }),
                    {
                        signal,
                        onRetry: (attempt) => {
                            logger.debug(`Retrying refresh (attempt ${attempt})`);
                        },
                    }
                );

                if (signal.aborted) return;

                let items = resp.items || [];
                // When scoped (filtered), narrow results to the requested post/thread.
                // For global-in-memory feeds (no filters), this guard is a no-op.
                const pid = filters?.postId || filters?.parentPostId;
                if (pid) {
                    items = items.filter(
                        (it: any) => String(it.postId || it.parentPostId) === String(pid)
                    );
                }

                const uniqueItems = deduplicateItems(items, getItemKey);
                // Prime the React Query actor cache (web feed's only actor source)
                precacheActorsFromPosts(uniqueItems);
                setLocalItems(uniqueItems);
                setLocalSlices(resp.slices || undefined);
                setLocalHasMore(!!resp.hasMore);
                setLocalNextCursor(resp.nextCursor);
            } else if (userId) {
                await fetchUserFeed(userId, { type, limit: 20, filters });
            } else {
                await refreshFeed(type, filters);
            }
        } catch (err: unknown) {
            if (signal.aborted) return;
            logger.error('Error refreshing feed after retries', { error: err });
            if (useMemoryFeed) {
                setLocalError('Failed to refresh');
            }
        } finally {
            if (useMemoryFeed) setLocalLoading(false);
        }
    }, [type, userId, showOnlySaved, useMemoryFeed, filters, refreshFeed, fetchUserFeed, clearError]);

    const loadMore = useCallback(async () => {
        if (isLoadingMoreRef.current) {
            logger.debug('Already loading more, skipping');
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

            if (useMemoryFeed) {
                if (!localHasMore || localLoading) {
                    isLoadingMoreRef.current = false;
                    return;
                }

                setLocalLoading(true);
                setLocalError(null);

                const feedReq: FeedRequest = { type, limit: 20, cursor: localNextCursor, filters };
                const resp = await withRetry(
                    () => userId
                        ? feedService.getUserFeed(userId, feedReq)
                        : feedService.getFeed({ type, limit: 20, cursor: localNextCursor, filters }, { signal }),
                    {
                        signal,
                        maxRetries: 2,
                        onRetry: (attempt) => {
                            logger.debug(`Retrying load more (attempt ${attempt})`);
                        },
                    }
                );

                if (signal.aborted) return;

                let items = resp.items || [];
                // When scoped (filtered), narrow results to the requested post/thread.
                // For global-in-memory feeds (no filters), this guard is a no-op.
                const pid = filters?.postId || filters?.parentPostId;
                if (pid) {
                    items = items.filter(
                        (it: any) => String(it.postId || it.parentPostId) === String(pid)
                    );
                }

                // Prime the React Query actor cache (web feed's only actor source)
                precacheActorsFromPosts(items);
                setLocalItems((prev) => {
                    const existingIds = new Set(prev.map(getItemKey));
                    const uniqueNew = deduplicateItems(items, getItemKey).filter(
                        (p) => !existingIds.has(getItemKey(p))
                    );
                    return prev.concat(uniqueNew);
                });

                const newSlices = resp.slices;
                if (newSlices && newSlices.length > 0) {
                    setLocalSlices((prev) => prev ? [...prev, ...newSlices] : newSlices);
                }

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
                logger.debug('Load more aborted');
                return;
            }
            logger.error('Error loading more', { error: err });
            if (useMemoryFeed) {
                let errorMessage = 'Failed to load more posts';
                if (err instanceof Error) errorMessage = err.message;
                setLocalError(errorMessage);
            }
        } finally {
            if (useMemoryFeed) setLocalLoading(false);
            isLoadingMoreRef.current = false;
        }
    }, [
        showOnlySaved,
        useMemoryFeed,
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

    // Handle reloadKey changes
    useDeepCompareEffect(() => {
        const reloadKeyChanged =
            previousReloadKeyRef.current !== undefined && previousReloadKeyRef.current !== reloadKey;
        previousReloadKeyRef.current = reloadKey;

        if (reloadKeyChanged) {
            fetchInitial(true);
        }
    }, [reloadKey]);

    // Handle initial load and filter changes. Switching feed identity also resets
    // the federated pending-poll budget so a new profile starts polling fresh.
    useDeepCompareEffect(() => {
        const reloadKeyChanged =
            previousReloadKeyRef.current !== undefined && previousReloadKeyRef.current !== reloadKey;
        if (reloadKeyChanged) return;

        clearPendingPoll();
        pendingPollCountRef.current = 0;
        setPending(false);

        fetchInitial(false);
    }, [type, userId, filters, useMemoryFeed, showOnlySaved]);

    // Return appropriate state based on which path is active.
    // useMemoryFeed covers both scoped (filtered) feeds and global feeds when SQLite
    // is unavailable (web without COOP/COEP). The SQLite path is only taken when
    // isDbAvailable() === true and no scoped filters are present.
    const items = useMemoryFeed ? localItems : globalFeed?.items || [];
    const slices = useMemoryFeed ? localSlices : globalFeed?.slices;
    const hasMore = useMemoryFeed ? localHasMore : !!globalFeed?.hasMore;
    const isLoading = useMemoryFeed ? localLoading : !!globalFeed?.isLoading;
    const error = useMemoryFeed ? localError : globalFeed?.error || null;
    const nextCursor = useMemoryFeed ? localNextCursor : globalFeed?.nextCursor;

    return {
        items,
        slices,
        hasMore,
        isLoading,
        error,
        nextCursor,
        pending,
        fetchInitial,
        refresh,
        loadMore,
        clearError,
    };
}
