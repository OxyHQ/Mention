import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import type {
    FeedInterstitialSlot,
    FeedType,
    FeedPostSlice,
    HydratedPost,
} from '@mention/shared-types';
import { usePostsStore, useFeedSelector, useUserFeedSelector } from '@/stores/postsStore';
import { FeedFilters, buildFeedScrollKey } from '@/utils/feedUtils';
import { createLogger } from '@oxy.so/core/logger';
import {
    classifyFeedFailure,
    logFeedFailure,
    type FeedFailureKind,
} from '@/utils/feedRetry';
import { useDeepCompareEffect } from './useDeepCompare';
import { buildFeedKey, hasFeedData, isDbAvailable } from '@/db';
import { resolveUseMemoryFeed } from '@/utils/feedMemoryMode';
import { isFeedReadStale } from '@/stores/feedStaleness';
import { FED_PENDING_POLL_DELAYS_MS, useFeedQuery } from './useFeedQuery';
import { useReloadOnFeedRuleChange } from './useReloadOnFeedRuleChange';

// Re-export so callers that already imported from here keep working.
export { resolveUseMemoryFeed } from '@/utils/feedMemoryMode';

const logger = createLogger('useFeedState');

export interface UseFeedStateOptions {
    type: FeedType;
    userId?: string;
    filters?: FeedFilters;
    useScoped?: boolean;
    reloadKey?: string | number;
    isAuthenticated?: boolean;
    currentUserId?: string;
}

export interface UseFeedStateReturn {
    /** Stable viewer/feed identity used by cache and scroll restoration. */
    feedScrollKey: string;
    items: HydratedPost[];
    slices?: FeedPostSlice[];
    /**
     * Recommendation-card placements accumulated across the loaded pages —
     * concatenated on `loadMore`, replaced on `fetchInitial`/`refresh`, exactly
     * like `slices`. Placements only; the cards fetch their own content.
     */
    interstitials?: FeedInterstitialSlot[];
    hasMore: boolean;
    isLoading: boolean;
    error: string | null;
    /**
     * What KIND of failure `error` was, for a surface that has to choose what to
     * say about it. `null` whenever there is no error. Only ever set after the
     * feed's retries are exhausted (`utils/feedRetry`), so a surface reading it
     * is never pre-empting a retry that is still in flight.
     */
    errorKind: FeedFailureKind | null;
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
 * SharedArrayBuffer is undefined). In memory mode the feed is one React Query
 * infinite query (`useFeedQuery`): its pages live in the query cache, which is
 * also what a remount warm-starts from.
 *
 * SQLite mode: activated when `isDbAvailable()` is true and no scoped filters are
 * present. Items are written to SQLite by postsStore and read back via selectors.
 * This is the native path and must remain byte-identical to the previous behavior.
 *
 * Both halves are always called — a hook cannot be called conditionally — and
 * the one that does not serve this feed stays idle.
 */
export function useFeedState({
    type,
    userId,
    filters,
    useScoped,
    reloadKey,
    isAuthenticated,
    currentUserId,
}: UseFeedStateOptions): UseFeedStateReturn {
    const useMemoryFeed = resolveUseMemoryFeed(useScoped, isDbAvailable());

    // Stable identity for this feed, used by scroll restoration. Recomputed
    // only when identity inputs change.
    const feedScrollKey = useMemo(
        () => buildFeedScrollKey({
            type,
            userId,
            filters,
            isAuthenticated,
            currentViewerId: currentUserId,
        }),
        [type, userId, filters, isAuthenticated, currentUserId]
    );

    const feed = { type, userId, filters, reloadKey, isAuthenticated, currentUserId };
    const queried = useFeedQuery({ ...feed, enabled: useMemoryFeed });
    const stored = useStoredFeed({ ...feed, enabled: !useMemoryFeed });

    return { feedScrollKey, ...(useMemoryFeed ? queried : stored) };
}

/**
 * The SQLite half of {@link useFeedState}: native, unscoped feeds. Items are
 * written to SQLite by postsStore and read back via selectors.
 */
function useStoredFeed({
    type,
    userId,
    filters,
    reloadKey,
    isAuthenticated,
    currentUserId,
    enabled,
}: Omit<UseFeedStateOptions, 'useScoped'> & { enabled: boolean }): Omit<UseFeedStateReturn, 'feedScrollKey'> {
    // Actions are stable for the lifetime of the Zustand store. Subscribe to
    // them individually so a keyed post revision does not re-render every
    // mounted feed hook merely because it previously selected the whole store.
    const fetchFeed = usePostsStore((state) => state.fetchFeed);
    const fetchUserFeed = usePostsStore((state) => state.fetchUserFeed);
    const refreshFeed = usePostsStore((state) => state.refreshFeed);
    const loadMoreFeed = usePostsStore((state) => state.loadMoreFeed);
    const clearFeed = usePostsStore((state) => state.clearFeed);
    const clearUserFeed = usePostsStore((state) => state.clearUserFeed);
    const clearGlobalError = usePostsStore((state) => state.clearError);

    const viewerIdentity = isAuthenticated && currentUserId ? currentUserId : 'anon';

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
    const globalFeedSelector = useFeedSelector(type);
    const userFeedSelector = useUserFeedSelector(userId || '', type);
    const globalFeed = userId ? userFeedSelector : globalFeedSelector;

    // Refs for preventing duplicate calls.
    //
    // Separate AbortControllers per operation class:
    //   - primaryAbortRef: initial load (fetchInitial) AND refresh. These are
    //     mutually exclusive "load the first page" operations, so they share a
    //     controller (a new refresh should supersede an in-flight initial load).
    //   - loadMoreAbortRef: pagination (loadMore). Every first-page operation
    //     invalidates this controller and advances the epoch below, so a late
    //     pagination response can never append to a freshly-refreshed feed even
    //     when its transport ignores AbortSignal.
    const isFetchingRef = useRef(false);
    const isLoadingMoreRef = useRef(false);
    const primaryAbortRef = useRef<AbortController | null>(null);
    const loadMoreAbortRef = useRef<AbortController | null>(null);
    const paginationEpochRef = useRef(0);
    const previousReloadKeyRef = useRef<string | number | undefined>(undefined);
    // AccountSwitchReset has already proved this initial identity before the
    // hook mounts. Any later difference is a real identity transition.
    const previousIdentityRef = useRef(viewerIdentity);

    const invalidatePagination = useCallback(() => {
        paginationEpochRef.current += 1;
        loadMoreAbortRef.current?.abort();
        loadMoreAbortRef.current = null;
        isLoadingMoreRef.current = false;
    }, []);

    useEffect(() => {
        return () => {
            paginationEpochRef.current += 1;
            if (primaryAbortRef.current) {
                primaryAbortRef.current.abort();
            }
            if (loadMoreAbortRef.current) {
                loadMoreAbortRef.current.abort();
            }
            clearPendingPoll();
        };
    }, [clearPendingPoll]);

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

    const fetchInitial = useCallback(
        async (forceRefresh: boolean = false) => {
            if (isFetchingRef.current && !forceRefresh) {
                logger.debug('Already fetching, skipping');
                return;
            }

            // A first-page read defines a new feed generation. Cancel pagination
            // immediately and advance its epoch before any cache/network branch
            // can complete, so a slow old page cannot append afterward.
            invalidatePagination();
            isFetchingRef.current = true;

            if (primaryAbortRef.current) {
                primaryAbortRef.current.abort();
            }
            const controller = new AbortController();
            primaryAbortRef.current = controller;
            const signal = controller.signal;
            // Only the operation that still owns the primary controller may
            // release the fetching gate, so a superseded request can't release
            // the gate of the request that replaced it.
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

            // Check SQLite for cached data (cold-start optimization). The cache
            // is only good if it postdates every write that changes what this
            // feed shows (`stores/feedStaleness`).
            if (!forceRefresh && !filters?.searchQuery) {
                const feedKey = userId
                    ? buildFeedKey(type, userId)
                    : buildFeedKey(type);

                // If SQLite has items AND the UI state shows it was previously fetched
                const ui = usePostsStore.getState().feedUI[feedKey];
                const hasDbData = hasFeedData(feedKey);

                if (
                    hasDbData
                    && ui?.lastUpdated
                    && ui.lastUpdated > 0
                    && !isFeedReadStale({ type, userId, filters, viewerId: currentUserId }, ui.lastUpdated)
                ) {
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
                clearGlobalError();

                if (userId) {
                    const { pending: isPending } = await fetchUserFeed(userId, { type, limit: 20, filters });
                    if (signal.aborted) return;
                    // Federated profile feed still syncing → schedule a bounded refetch.
                    // `fetchUserFeed` already reports `pending` only when items are empty.
                    applyPendingResult(isPending, !isPending);
                } else if (forceRefresh) {
                    await refreshFeed(type, filters);
                } else {
                    await fetchFeed({ type, limit: 20, filters });
                }
            } catch (err: unknown) {
                if (signal.aborted) {
                    logger.debug('Request aborted');
                    return;
                }
                const failure = classifyFeedFailure(err);
                logFeedFailure(logger, 'Feed load failed', failure, { feedType: type });
            } finally {
                // Only release the gate if this request still owns the primary
                // controller; otherwise a newer request has taken over.
                if (ownsPrimary()) {
                    isFetchingRef.current = false;
                }
            }
        },
        [
            type,
            userId,
            isAuthenticated,
            currentUserId,
            filters,
            fetchFeed,
            fetchUserFeed,
            refreshFeed,
            clearGlobalError,
            applyPendingResult,
            invalidatePagination,
        ]
    );

    // Keep the ref pointing at the latest fetchInitial for the pending-poll scheduler.
    fetchInitialRef.current = fetchInitial;

    // The listener reads the current `fetchInitial` off the ref, so it never
    // needs re-subscribing while this half serves the feed.
    const reloadStored = useCallback(() => fetchInitialRef.current?.(true), []);
    useReloadOnFeedRuleChange(enabled, reloadStored);

    const refresh = useCallback(async () => {
        // Gate onEndReached synchronously before the store commits isLoading.
        isFetchingRef.current = true;
        // Refresh replaces the accumulated feed. Invalidate pagination before
        // starting it so even an uncancellable, late loadMore response is stale.
        invalidatePagination();
        if (primaryAbortRef.current) {
            primaryAbortRef.current.abort();
        }
        const controller = new AbortController();
        primaryAbortRef.current = controller;
        const signal = controller.signal;
        // See fetchInitial: only the operation still owning the primary
        // controller may release the fetching gate.
        const ownsPrimary = () => primaryAbortRef.current === controller;

        try {
            clearGlobalError();

            if (userId) {
                await fetchUserFeed(userId, { type, limit: 20, filters });
            } else {
                await refreshFeed(type, filters);
            }
        } catch (err: unknown) {
            if (signal.aborted) return;
            const failure = classifyFeedFailure(err);
            logFeedFailure(logger, 'Feed refresh failed', failure, { feedType: type });
        } finally {
            if (ownsPrimary()) {
                isFetchingRef.current = false;
            }
        }
    }, [
        type,
        userId,
        filters,
        refreshFeed,
        fetchUserFeed,
        clearGlobalError,
        invalidatePagination,
    ]);

    const loadMore = useCallback(async () => {
        if (isFetchingRef.current || isLoadingMoreRef.current) {
            logger.debug('First page or pagination already loading, skipping');
            return;
        }

        if (loadMoreAbortRef.current) {
            loadMoreAbortRef.current.abort();
        }
        const controller = new AbortController();
        loadMoreAbortRef.current = controller;
        const signal = controller.signal;
        const paginationEpoch = paginationEpochRef.current;
        // Only the operation still owning the loadMore controller may release
        // the pagination gate, so a superseded loadMore can't release the gate
        // of the loadMore that replaced it.
        const ownsLoadMore = () =>
            loadMoreAbortRef.current === controller
            && paginationEpochRef.current === paginationEpoch;

        isLoadingMoreRef.current = true;

        try {
            if (userId) {
                await fetchUserFeed(userId, {
                    type,
                    limit: 20,
                    cursor: globalFeed?.nextCursor,
                    filters,
                });
            } else {
                await loadMoreFeed(type, filters);
            }
        } catch (err: unknown) {
            if (signal.aborted) {
                logger.debug('Load more aborted');
                return;
            }
            const failure = classifyFeedFailure(err);
            logFeedFailure(logger, 'Feed pagination failed', failure, { feedType: type });
        } finally {
            // Only release the gate if this loadMore still owns its controller.
            if (ownsLoadMore()) {
                isLoadingMoreRef.current = false;
            }
        }
    }, [
        type,
        userId,
        filters,
        globalFeed?.nextCursor,
        loadMoreFeed,
        fetchUserFeed,
    ]);

    // Handle reloadKey changes
    useDeepCompareEffect(() => {
        if (!enabled) return;
        const reloadKeyChanged =
            previousReloadKeyRef.current !== undefined && previousReloadKeyRef.current !== reloadKey;
        previousReloadKeyRef.current = reloadKey;

        if (reloadKeyChanged) {
            fetchInitial(true);
        }
    }, [reloadKey, enabled]);

    // Handle initial load, filter changes, and auth-identity changes. This effect
    // is keyed on the reactive auth identity (`isAuthenticated` + `currentUserId`)
    // so that when a session restores asynchronously on cold boot — flipping
    // anon→authed after mount — the initial fetch re-runs against the now-ready
    // token instead of being stranded on the anonymous (or empty) result.
    //
    // Switching feed identity also resets the federated pending-poll budget so a
    // new profile starts polling fresh.
    useDeepCompareEffect(() => {
        if (!enabled) return;
        const reloadKeyChanged =
            previousReloadKeyRef.current !== undefined && previousReloadKeyRef.current !== reloadKey;
        if (reloadKeyChanged) return;

        // The auth identity this run represents: the authenticated user id when
        // signed in, the literal 'anon' otherwise.
        const identity = viewerIdentity;
        const previousIdentity = previousIdentityRef.current;
        const identityChanged = previousIdentity !== identity;
        previousIdentityRef.current = identity;

        // The initial ref is this concrete viewer, whose persisted boundary was
        // already proved or cleared by AccountSwitchReset before descendants
        // mounted. Only a real identity transition within this mounted hook
        // invalidates displayed state; the trust gate below hides the old rows
        // synchronously.
        if (identityChanged) {
            if (userId) {
                clearUserFeed(userId, type);
            } else {
                clearFeed(type);
            }
        }

        clearPendingPoll();
        pendingPollCountRef.current = 0;
        setPending(false);

        fetchInitial(identityChanged);
    }, [
        type,
        userId,
        filters,
        enabled,
        isAuthenticated,
        currentUserId,
        viewerIdentity,
        clearFeed,
        clearUserFeed,
    ]);

    const isViewerCacheTrusted = previousIdentityRef.current === viewerIdentity;
    const error = globalFeed?.error || null;

    return {
        items: isViewerCacheTrusted ? globalFeed?.items || [] : [],
        slices: isViewerCacheTrusted ? globalFeed?.slices : undefined,
        // Card placements are viewer-specific (the server only emits them for an
        // authenticated viewer), so they follow the same trust gate as the items.
        interstitials: isViewerCacheTrusted ? globalFeed?.interstitials : undefined,
        hasMore: !!globalFeed?.hasMore,
        isLoading: !isViewerCacheTrusted || !!globalFeed?.isLoading,
        error,
        // The SQLite path classifies at the point it catches — in `postsStore` —
        // so nothing here re-derives a kind from a message string.
        errorKind: error ? globalFeed?.errorKind ?? null : null,
        pending,
        fetchInitial,
        refresh,
        loadMore,
        clearError: clearGlobalError,
    };
}
