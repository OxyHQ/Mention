import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { FeedType, FeedPostSlice, FeedRequest, HydratedPost } from '@mention/shared-types';
import { usePostsStore, useFeedSelector, useUserFeedSelector } from '@/stores/postsStore';
import { feedService } from '@/services/feedService';
import { FeedFilters, getItemKey, deduplicateItems, buildFeedScrollKey } from '@/utils/feedUtils';
import { createScopedLogger } from '@/lib/logger';
import { useDeepCompareEffect } from './useDeepCompare';
import { buildFeedKey, hasFeedData, isDbAvailable } from '@/db';
import { resolveUseMemoryFeed } from '@/utils/feedMemoryMode';
import { precacheActorsFromPosts } from '@/lib/precacheActorsFromPosts';
import {
    getFeedMemoryCache,
    setFeedMemoryCache,
    subscribeToNewLocalPosts,
    type FeedMemoryCacheEntry,
} from '@/stores/feedScrollStore';

// Re-export so callers that already imported from here keep working.
export { resolveUseMemoryFeed } from '@/utils/feedMemoryMode';

const logger = createScopedLogger('useFeedState');

// Retry configuration
const MAX_RETRIES = 3;
const BASE_RETRY_DELAY = 1000;

// Federated outbox-sync polling: when a profile feed responds with `pending`
// (its ActivityPub outbox is still syncing in the background), we refetch a few
// times until posts arrive, then stop. The delays back off (1s → 2.5s → 5s) so
// the first retry lands quickly when the sync is nearly done while later retries
// space out instead of hammering a still-syncing outbox. The number of entries
// is the (bounded) poll budget, so we never poll indefinitely.
const FED_PENDING_POLL_DELAYS_MS = [1000, 2500, 5000] as const;

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
        cachePosts,
        clearError: clearGlobalError,
    } = usePostsStore();

    // useMemoryFeed is true when:
    //   1. useScoped is set (filtered/scoped feed — always uses local state), OR
    //   2. SQLite is unavailable (web without COOP/COEP, SharedArrayBuffer undefined)
    // When true, all feed items live in local React state (localItems/localNextCursor/…).
    // When false (SQLite available, no filters), items live in SQLite and are read via
    // selectors — this is the standard native path.
    const useMemoryFeed = resolveUseMemoryFeed(useScoped, isDbAvailable());

    // Stable identity for this feed. Used to retain memory-mode items across an
    // unmount→remount (e.g. navigating to `/videos` and back) so the saved
    // scroll offset lands on the same items. Recomputed only when identity
    // inputs change.
    const feedScrollKey = useMemo(
        () => buildFeedScrollKey({ type, userId, showOnlySaved, filters }),
        [type, userId, showOnlySaved, filters]
    );

    // Warm-start seed: in memory mode, if we retained this feed's slice from a
    // previous mount, hydrate local state from it synchronously so the list
    // renders the full previously-loaded set immediately (no flash of page 1,
    // no refetch-from-scratch that would invalidate the restored offset).
    // Read once at mount via lazy initializers — not reactive by design.
    const seededCacheRef = useRef<FeedMemoryCacheEntry | undefined>(
        (() => {
            if (!useMemoryFeed) return undefined;
            const cached = getFeedMemoryCache(feedScrollKey);
            // Only treat a non-empty slice as a warm start. An empty cached set
            // would otherwise suppress the cold fetch and strand an empty feed.
            return cached && cached.items.length > 0 ? cached : undefined;
        })()
    );
    const seed = seededCacheRef.current;

    // Local state for scoped feeds
    const [localItems, setLocalItems] = useState<HydratedPost[]>(() => seed?.items ?? []);
    const [localSlices, setLocalSlices] = useState<FeedPostSlice[] | undefined>(() => seed?.slices);
    const [localHasMore, setLocalHasMore] = useState<boolean>(() => seed ? seed.hasMore : true);
    const [localNextCursor, setLocalNextCursor] = useState<string | undefined>(() => seed?.nextCursor);
    const [localLoading, setLocalLoading] = useState<boolean>(false);
    const [localError, setLocalError] = useState<string | null>(null);

    // Latest local items/slices, mirrored into refs so the new-post broadcast
    // listener can read current state without re-subscribing on every change and
    // without depending on possibly-stale closure values.
    const localItemsRef = useRef(localItems);
    localItemsRef.current = localItems;
    const localSlicesRef = useRef(localSlices);
    localSlicesRef.current = localSlices;

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

    // Refs for preventing duplicate calls.
    //
    // Separate AbortControllers per operation class so concurrent operations
    // never cancel each other:
    //   - primaryAbortRef: initial load (fetchInitial) AND refresh. These are
    //     mutually exclusive "load the first page" operations, so they share a
    //     controller (a new refresh should supersede an in-flight initial load).
    //   - loadMoreAbortRef: pagination (loadMore). A pull-to-refresh during a
    //     loadMore (or vice versa) now aborts only its own prior request, never
    //     the other operation's in-flight fetch.
    const isFetchingRef = useRef(false);
    const isLoadingMoreRef = useRef(false);
    const primaryAbortRef = useRef<AbortController | null>(null);
    const loadMoreAbortRef = useRef<AbortController | null>(null);
    const previousReloadKeyRef = useRef<string | number | undefined>(undefined);
    // Tracks the auth identity the currently-displayed feed was loaded under, so a
    // change (anon→user, or user A→user B) can invalidate the stale cache before
    // the fresh authenticated feed is fetched. `undefined` means "not yet seen".
    const previousIdentityRef = useRef<string | undefined>(undefined);

    useEffect(() => {
        return () => {
            if (primaryAbortRef.current) {
                primaryAbortRef.current.abort();
            }
            if (loadMoreAbortRef.current) {
                loadMoreAbortRef.current.abort();
            }
            clearPendingPoll();
        };
    }, [clearPendingPoll]);

    // Memory-mode home feeds (web without SQLite) don't read SQLite, so a post
    // created by postsStore won't appear until a manual refresh. Subscribe to the
    // new-post broadcast and prepend it to the live items + retained cache,
    // mirroring the SQLite "insert at top" behavior. Scoped/filtered feeds and
    // the saved feed never receive arbitrary new posts; a profile feed only shows
    // its own author's new post — matching the SQLite path's feed-key selection.
    const HOME_FEED_TYPES = useMemo(() => new Set<FeedType>(['mixed', 'for_you', 'following', 'posts']), []);
    useEffect(() => {
        if (!useMemoryFeed || useScoped || showOnlySaved) return;
        const isHomeFeed = !userId && HOME_FEED_TYPES.has(type);
        if (!isHomeFeed && !userId) return;

        return subscribeToNewLocalPosts((item) => {
            // For a profile feed, only prepend the post if it belongs to that user.
            if (userId && String((item as HydratedPost)?.user?.id ?? '') !== String(userId)) {
                return;
            }

            const key = getItemKey(item);

            // Prepend to live items (pure updater — dedup is order-stable).
            setLocalItems((prev) =>
                prev.some((p) => getItemKey(p) === key) ? prev : [item, ...prev]
            );

            // When the feed renders via slices (Feed.tsx prefers slices over items),
            // prepend a single-post slice so the new post is visible there too.
            const buildLocalSlice = (): FeedPostSlice => ({
                _sliceKey: `local-new:${key}`,
                isIncompleteThread: false,
                items: [{
                    post: item,
                    isThreadParent: false,
                    isThreadChild: false,
                    isThreadLastChild: false,
                }],
            });
            setLocalSlices((prev) => {
                if (!prev) return prev;
                const alreadyPresent = prev.some((slice) =>
                    slice.items.some((si) => getItemKey(si.post) === key)
                );
                return alreadyPresent ? prev : [buildLocalSlice(), ...prev];
            });

            // Keep the retained slice in sync so an unmount→remount still shows it.
            // The retained cache is the source of truth for memory mode, so compute
            // the next snapshot from it (not from possibly-stale closure state).
            const existing = getFeedMemoryCache(feedScrollKey);
            const existingItems = existing?.items ?? localItemsRef.current;
            if (!existingItems.some((p) => getItemKey(p) === key)) {
                const existingSlices = existing?.slices ?? localSlicesRef.current;
                const nextSlices = existingSlices
                    && !existingSlices.some((slice) =>
                        slice.items.some((si) => getItemKey(si.post) === key))
                    ? [buildLocalSlice(), ...existingSlices]
                    : existingSlices;
                setFeedMemoryCache(feedScrollKey, {
                    items: [item, ...existingItems],
                    slices: nextSlices,
                    hasMore: existing?.hasMore ?? localHasMore,
                    nextCursor: existing?.nextCursor ?? localNextCursor,
                });
            }
        });
    }, [
        useMemoryFeed,
        useScoped,
        showOnlySaved,
        userId,
        type,
        HOME_FEED_TYPES,
        feedScrollKey,
        localHasMore,
        localNextCursor,
    ]);

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
            // `pendingPollCountRef` is how many retries have already run, so it
            // also indexes the backoff delay for the NEXT retry (0 → 1s, …).
            const delay = FED_PENDING_POLL_DELAYS_MS[pendingPollCountRef.current];
            if (delay !== undefined) {
                clearPendingPoll();
                pendingTimerRef.current = setTimeout(() => {
                    pendingPollCountRef.current += 1;
                    fetchInitialRef.current?.(true);
                }, delay);
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

    // Retain the current memory-mode slice under this feed's identity so a
    // remount can warm-start from it. No-op outside memory mode (SQLite retains
    // its own data). Called after every successful memory-mode state update.
    const retainMemoryCache = useCallback(
        (entry: FeedMemoryCacheEntry) => {
            if (!useMemoryFeed) return;
            setFeedMemoryCache(feedScrollKey, entry);
        },
        [useMemoryFeed, feedScrollKey]
    );

    const fetchInitial = useCallback(
        async (forceRefresh: boolean = false) => {
            if (isFetchingRef.current) {
                logger.debug('Already fetching, skipping');
                return;
            }

            isFetchingRef.current = true;

            if (primaryAbortRef.current) {
                primaryAbortRef.current.abort();
            }
            const controller = new AbortController();
            primaryAbortRef.current = controller;
            const signal = controller.signal;
            // Only the operation that still owns the primary controller may toggle
            // the shared memory-mode loading flag, so a superseded request can't
            // clear the spinner of the request that replaced it.
            const ownsPrimary = () => primaryAbortRef.current === controller;

            // Transient cold-boot guard: at restore, `isAuthenticated` can flip true
            // a tick before `currentUserId` lands. Skipping here is safe ONLY because
            // the initial-fetch effect is keyed on `currentUserId` — once the id
            // arrives the effect re-runs and this fetch proceeds. Without that dep
            // this skip would be permanent (infinite spinner).
            if (isAuthenticated && !currentUserId) {
                logger.debug('Auth resolving (no user id yet), deferring fetch until id lands');
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

            // Memory-mode warm start: if this mount was seeded from a retained
            // slice and this isn't a forced refresh, skip the cold fetch. A
            // from-scratch fetch here would replace the cached items (including
            // pages > 1) with just page 1, losing the user's scroll context.
            // The seed is consumed once so a later forceRefresh still refetches.
            if (useMemoryFeed && !forceRefresh && seededCacheRef.current) {
                logger.debug('Skipping — memory feed warm-started from cache');
                seededCacheRef.current = undefined;
                isFetchingRef.current = false;
                return;
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
                            : feedService.getFeed({ type, limit: 20, filters }, { signal }),
                        {
                            signal,
                            onRetry: (attempt) => {
                                logger.debug(`Retrying feed request (attempt ${attempt})`);
                            },
                        }
                    );

                    if (signal.aborted || !ownsPrimary()) return;

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
                    if (userId && resp.pending === true && uniqueItems.length === 0 && localItemsRef.current.length > 0) {
                        applyPendingResult(true, false);
                        return;
                    }

                    // Prime the React Query actor cache so avatars/names render
                    // on web (no SQLite). This is the web feed's only actor source.
                    precacheActorsFromPosts(uniqueItems);
                    // Seed the shared post cache so the post-detail screen can
                    // render instantly from `getPostFromDb(id)` instead of issuing
                    // a cold blocking fetch on open. Memory mode keeps its own
                    // ordering in local state; this only upserts the post objects.
                    cachePosts(uniqueItems);
                    const initialSlices = resp.slices || undefined;
                    const initialHasMore = !!resp.hasMore;
                    setLocalItems(uniqueItems);
                    setLocalSlices(initialSlices);
                    setLocalHasMore(initialHasMore);
                    setLocalNextCursor(resp.nextCursor);
                    // A fresh fetch overwrites any retained slice so the cache
                    // never drifts from what is on screen.
                    retainMemoryCache({
                        items: uniqueItems,
                        slices: initialSlices,
                        hasMore: initialHasMore,
                        nextCursor: resp.nextCursor,
                    });

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
                if (useMemoryFeed && ownsPrimary()) {
                    setLocalError('Failed to load');
                }
            } finally {
                // Only clear the spinner if this request still owns the primary
                // controller; otherwise a newer request has taken over and is
                // responsible for its own loading state.
                if (useMemoryFeed && ownsPrimary()) setLocalLoading(false);
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
            cachePosts,
            clearError,
            applyPendingResult,
            retainMemoryCache,
        ]
    );

    // Keep the ref pointing at the latest fetchInitial for the pending-poll scheduler.
    fetchInitialRef.current = fetchInitial;

    const refresh = useCallback(async () => {
        if (primaryAbortRef.current) {
            primaryAbortRef.current.abort();
        }
        const controller = new AbortController();
        primaryAbortRef.current = controller;
        const signal = controller.signal;
        // See fetchInitial: only the operation still owning the primary
        // controller may toggle the shared memory-mode loading flag.
        const ownsPrimary = () => primaryAbortRef.current === controller;

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
                        : feedService.getFeed({ type, limit: 20, filters }, { signal }),
                    {
                        signal,
                        onRetry: (attempt) => {
                            logger.debug(`Retrying refresh (attempt ${attempt})`);
                        },
                    }
                );

                if (signal.aborted || !ownsPrimary()) return;

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
                if (userId && resp.pending === true && uniqueItems.length === 0 && localItemsRef.current.length > 0) {
                    applyPendingResult(true, false);
                    return;
                }

                // Prime the React Query actor cache (web feed's only actor source)
                precacheActorsFromPosts(uniqueItems);
                // Seed the shared post cache for instant post-detail open (see fetchInitial).
                cachePosts(uniqueItems);
                const refreshedSlices = resp.slices || undefined;
                const refreshedHasMore = !!resp.hasMore;
                setLocalItems(uniqueItems);
                setLocalSlices(refreshedSlices);
                setLocalHasMore(refreshedHasMore);
                setLocalNextCursor(resp.nextCursor);
                // A refresh rebuilds the feed from page 1, so overwrite the
                // retained slice with the fresh set.
                retainMemoryCache({
                    items: uniqueItems,
                    slices: refreshedSlices,
                    hasMore: refreshedHasMore,
                    nextCursor: resp.nextCursor,
                });
            } else if (userId) {
                await fetchUserFeed(userId, { type, limit: 20, filters });
            } else {
                await refreshFeed(type, filters);
            }
        } catch (err: unknown) {
            if (signal.aborted) return;
            logger.error('Error refreshing feed after retries', { error: err });
            if (useMemoryFeed && ownsPrimary()) {
                setLocalError('Failed to refresh');
            }
        } finally {
            if (useMemoryFeed && ownsPrimary()) setLocalLoading(false);
        }
    }, [type, userId, showOnlySaved, useMemoryFeed, filters, refreshFeed, fetchUserFeed, cachePosts, clearError, retainMemoryCache]);

    const loadMore = useCallback(async () => {
        if (isLoadingMoreRef.current) {
            logger.debug('Already loading more, skipping');
            return;
        }

        if (loadMoreAbortRef.current) {
            loadMoreAbortRef.current.abort();
        }
        const controller = new AbortController();
        loadMoreAbortRef.current = controller;
        const signal = controller.signal;
        // Only the operation still owning the loadMore controller may toggle the
        // shared memory-mode loading flag, so a superseded loadMore can't clear
        // the spinner of the loadMore that replaced it.
        const ownsLoadMore = () => loadMoreAbortRef.current === controller;

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

                if (signal.aborted || !ownsLoadMore()) return;

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
                // Seed the shared post cache for instant post-detail open (see fetchInitial).
                cachePosts(items);

                const prevCursor = localNextCursor;
                const nextCursor = resp.nextCursor;
                const cursorAdvanced = !!nextCursor && nextCursor !== prevCursor;
                const mergedHasMore = !!resp.hasMore && cursorAdvanced;
                const newSlices = resp.slices;

                // Compute the merged set up-front against the current state
                // (closure values), so both the React state update and the cache
                // write use the exact same result — independent of when React
                // commits the functional updaters. `localItems`/`localSlices`
                // are in this callback's dependency list, so the closure is fresh.
                const existingIds = new Set(localItems.map(getItemKey));
                const uniqueNew = deduplicateItems(items, getItemKey).filter(
                    (p) => !existingIds.has(getItemKey(p))
                );
                const mergedItems = localItems.concat(uniqueNew);
                const mergedSlices = newSlices && newSlices.length > 0
                    ? (localSlices ? [...localSlices, ...newSlices] : newSlices)
                    : localSlices;

                setLocalItems(mergedItems);
                if (mergedSlices !== localSlices) {
                    setLocalSlices(mergedSlices);
                }
                setLocalHasMore(mergedHasMore);
                setLocalNextCursor(nextCursor);

                // Retain the paginated set so a remount restores the full list
                // (pages > 1 included) and the saved offset lands correctly.
                retainMemoryCache({
                    items: mergedItems,
                    slices: mergedSlices,
                    hasMore: mergedHasMore,
                    nextCursor,
                });
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
            if (useMemoryFeed && ownsLoadMore()) {
                let errorMessage = 'Failed to load more posts';
                if (err instanceof Error) errorMessage = err.message;
                setLocalError(errorMessage);
            }
        } finally {
            // Only clear the spinner if this loadMore still owns its controller.
            if (useMemoryFeed && ownsLoadMore()) setLocalLoading(false);
            isLoadingMoreRef.current = false;
        }
    }, [
        showOnlySaved,
        useMemoryFeed,
        localHasMore,
        localLoading,
        localNextCursor,
        localItems,
        localSlices,
        type,
        effectiveType,
        userId,
        filters,
        globalFeed?.nextCursor,
        loadMoreFeed,
        fetchUserFeed,
        cachePosts,
        retainMemoryCache,
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

    // Handle initial load, filter changes, and auth-identity changes. This effect
    // is keyed on the reactive auth identity (`isAuthenticated` + `currentUserId`)
    // so that when a session restores asynchronously on cold boot — flipping
    // anon→authed after mount — the initial fetch re-runs against the now-ready
    // token instead of being stranded on the anonymous (or empty) result.
    //
    // Switching feed identity also resets the federated pending-poll budget so a
    // new profile starts polling fresh.
    useDeepCompareEffect(() => {
        const reloadKeyChanged =
            previousReloadKeyRef.current !== undefined && previousReloadKeyRef.current !== reloadKey;
        if (reloadKeyChanged) return;

        // The auth identity this run represents: the authenticated user id when
        // signed in, the literal 'anon' otherwise. Saved feeds never key on the
        // viewer, so their identity is constant.
        const identity = showOnlySaved
            ? 'saved'
            : (isAuthenticated && currentUserId ? currentUserId : 'anon');
        const previousIdentity = previousIdentityRef.current;
        const identityChanged =
            previousIdentity !== undefined && previousIdentity !== identity;
        previousIdentityRef.current = identity;

        // When the viewer changes (anon→user, or user A→user B), bypass warm-start
        // suppression and force a network refresh. Keep the current items on screen
        // until the fresh result arrives so cold-boot auth restoration never flashes
        // an empty profile/feed.
        if (identityChanged) {
            seededCacheRef.current = undefined;
        }

        clearPendingPoll();
        pendingPollCountRef.current = 0;
        setPending(false);

        fetchInitial(identityChanged);
    }, [type, userId, filters, useMemoryFeed, showOnlySaved, isAuthenticated, currentUserId]);

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
