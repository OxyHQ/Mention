import { useCallback, useEffect, useMemo, useRef } from 'react';
import {
    infiniteQueryOptions,
    useInfiniteQuery,
    useQueryClient,
} from '@tanstack/react-query';
import type { FeedType } from '@mention/shared-types';
import { createLogger } from '@oxy.so/core/logger';
import { feedService, type ExtendedFeedRequest } from '@/services/feedService';
import { usePostsStore } from '@/stores/postsStore';
import { precacheActorsFromPosts } from '@/lib/precacheActorsFromPosts';
import { viewerQueryKeys } from '@/lib/viewerQueryKeys';
import {
    foldFeedPages,
    type FeedPage,
    type FeedPageParam,
    type FeedQueryData,
} from '@/stores/feedQueryCache';
import { isFeedReadStale, type FeedReadIdentity } from '@/stores/feedStaleness';
import { classifyFeedFailure, logFeedFailure } from '@/utils/feedRetry';
import { feedThreadParentId, mergeFeedPageContent, type FeedFilters } from '@/utils/feedUtils';
import { useDeepCompareMemo } from './useDeepCompare';
import type { UseFeedStateReturn } from './useFeedState';
import { useReloadOnFeedRuleChange } from './useReloadOnFeedRuleChange';

const logger = createLogger('useFeedQuery');

const FEED_PAGE_SIZE = 20;

// Federated outbox-sync polling: when a profile feed responds with `pending`
// (its ActivityPub outbox is still syncing in the background), we refetch a few
// times until posts arrive, then stop. The delays back off (1s → 2.5s → 5s) so
// the first retry lands quickly when the sync is nearly done while later retries
// space out instead of hammering a still-syncing outbox. The number of entries
// is the (bounded) poll budget, so we never poll indefinitely.
export const FED_PENDING_POLL_DELAYS_MS = [1000, 2500, 5000] as const;

/** One feed, as the reader it is read for sees it. */
type FeedQueryTarget = FeedReadIdentity;

/**
 * Read one page of a feed, exactly as the feed's earlier local-state reader did:
 * a thread's replies narrowed to that thread, the page normalised, and its posts
 * and actors seeded into the entity caches every row overlays.
 */
async function readFeedPage(
    feed: FeedQueryTarget,
    cursor: FeedPageParam,
    signal: AbortSignal,
): Promise<FeedPage> {
    // No retry wrapper here: `feedService` owns the one policy (see
    // `utils/feedRetry`), so this read has already exhausted its attempts by
    // the time it rejects — and the query stays fetching for all of them, which
    // is why a blip never flashes an error screen.
    const request: ExtendedFeedRequest = { type: feed.type, limit: FEED_PAGE_SIZE, cursor, filters: feed.filters };
    const response = await (feed.userId
        ? feedService.getUserFeed(feed.userId, request, { signal })
        : feedService.getFeed(request, { signal }));

    // When scoped to a thread, narrow the results to the posts that answer it.
    const parentId = feedThreadParentId(feed.filters);
    const items = parentId
        ? (response.items ?? []).filter((item) => String(item.parentPostId) === parentId)
        : response.items ?? [];
    const content = mergeFeedPageContent(undefined, {
        items,
        slices: response.slices,
        interstitials: response.interstitials,
    });

    // Prime the React Query actor cache so avatars/names render on web (no
    // SQLite) — this is the web feed's only actor source — and seed the shared
    // post cache, so a row overlays the canonical post by id and the post-detail
    // screen renders instantly from `getPostFromDb(id)`. The query keeps its
    // own ordering; this only upserts the post objects.
    precacheActorsFromPosts(content.items);
    usePostsStore.getState().cachePosts(content.items);

    return {
        ...content,
        hasMore: Boolean(response.hasMore),
        nextCursor: response.nextCursor,
        pending: Boolean(feed.userId) && response.pending === true && content.items.length === 0,
    };
}

function feedQueryOptions(feed: FeedQueryTarget) {
    return infiniteQueryOptions({
        queryKey: viewerQueryKeys.feed(feed.viewerId, feed.type, feed.userId, feed.filters),
        queryFn: async ({ pageParam, signal, client, queryKey }): Promise<FeedPage> => {
            try {
                const page = await readFeedPage(feed, pageParam, signal);
                // A still-syncing outbox answering empty is not the profile
                // emptying: a first page already on screen stays, flagged
                // pending, until the outbox catches up.
                if (page.pending && pageParam === undefined) {
                    const shown = client.getQueryData<FeedQueryData>(queryKey)?.pages[0];
                    if (shown && shown.items.length > 0) return { ...shown, pending: true };
                }
                return page;
            } catch (error) {
                // A superseded read is not a failure; anything else is one the
                // feed service has already retried, so it is a warn with a
                // bounded context (`logFeedFailure`), never a red console entry.
                if (!signal.aborted) {
                    logFeedFailure(
                        logger,
                        pageParam === undefined ? 'Feed load failed' : 'Feed pagination failed',
                        classifyFeedFailure(error),
                        { feedType: feed.type },
                    );
                }
                throw error;
            }
        },
        initialPageParam: undefined as FeedPageParam,
        // A page that claims more but hands back the cursor it was read with
        // would page forever; it is the end.
        getNextPageParam: (lastPage, _pages, lastPageParam) =>
            lastPage.hasMore && lastPage.nextCursor && lastPage.nextCursor !== lastPageParam
                ? lastPage.nextCursor
                : undefined,
        // Staleness is decided by RULE, never by age: a remount renders the
        // cached pages and requests nothing, unless a write the feed cannot
        // see has happened since its read (the mount effect below). Kept for
        // the session, like the slice this replaced — an account switch
        // clears the whole client (`AccountSwitchReset`).
        staleTime: Infinity,
        gcTime: Infinity,
        // One retry policy, owned by `feedService`.
        retry: false,
    });
}

function ignoreRejection(): void {
    // The failure is already the query's state — the feed renders it from
    // there — and the query function logged it as it failed.
}

/**
 * The feed-query half of {@link useFeedState}: every feed it serves in memory
 * mode — all of web, and every scoped feed on native. One infinite query per
 * feed identity, keyed by viewer, type, profile and filters
 * (`viewerQueryKeys.feed`).
 *
 * The query cache is the retention: a feed that unmounts (web replaces the home
 * feed with `/videos`, or with the composer) renders its cached pages
 * synchronously when it remounts, which is what Bloom's web scroll restoration
 * needs to land on the same rows. A remount requests nothing unless a write has
 * made the held read stale; then it reads page 1 again, never every loaded page.
 */
export function useFeedQuery({
    type,
    userId,
    filters,
    reloadKey,
    isAuthenticated,
    currentUserId,
    enabled,
}: {
    type: FeedType;
    userId?: string;
    filters?: FeedFilters;
    reloadKey?: string | number;
    isAuthenticated?: boolean;
    currentUserId?: string;
    enabled: boolean;
}): Omit<UseFeedStateReturn, 'feedScrollKey'> {
    const queryClient = useQueryClient();

    // At restore, `isAuthenticated` can flip true a tick before `currentUserId`
    // lands. There is no key that read could be cached under — it is neither
    // the anonymous viewer's nor this viewer's — so nothing is read or shown
    // until the id arrives, and the key then carries it.
    const viewerReady = !isAuthenticated || Boolean(currentUserId);
    const active = enabled && viewerReady;
    const viewerId = isAuthenticated ? currentUserId : undefined;

    // Callers rebuild `filters` inline; compared by value so an equal object
    // keeps the same options, and the same `reload`.
    const feed = useDeepCompareMemo(
        (): FeedQueryTarget => ({ type, userId, filters, viewerId }),
        [type, userId, filters, viewerId],
    );
    const options = useMemo(() => feedQueryOptions(feed), [feed]);
    const { queryKey } = options;

    const {
        data,
        error,
        isFetching,
        hasNextPage,
        fetchNextPage,
        dataUpdatedAt,
    } = useInfiniteQuery({
        ...options,
        enabled: active,
        // An inactive observer (the SQLite half's feeds, a viewer still
        // resolving) leaves an entry that never loads; it is not retention.
        gcTime: active ? options.gcTime : 0,
    });

    const pages = viewerReady ? data?.pages : undefined;
    const content = useMemo(() => foldFeedPages(pages ?? []), [pages]);

    /**
     * Read the feed from its first page again: a pull-to-refresh, a reload, a
     * rule change, a stale warm start, a pending poll. ONE request — the default
     * refetch reads every loaded page again — and the loaded rows stay on screen
     * until it lands and replaces them.
     */
    const reload = useCallback(async () => {
        // A newer read supersedes whatever is in flight: a late page 2 must
        // never land on top of a fresh page 1.
        await queryClient.cancelQueries({ queryKey, exact: true });
        await queryClient.infiniteQuery({ ...options, pages: 1, staleTime: 0 }).catch(ignoreRejection);
    }, [queryClient, queryKey, options]);

    // A warm start judges the read it holds. A cold feed is already loading
    // itself, so only a cached read is asked about.
    //
    // A thread's replies always read again: the list seeds instantly from the
    // cache (no flash) but server-side changes — new, deleted, duplicate
    // replies — must show on navigation, not only on a hard reload. Freshness
    // wins over scroll preservation there, and a replies list has no
    // deep-scroll context worth keeping.
    //
    // Any other feed reads again only when a write it cannot see postdates its
    // read (`stores/feedStaleness`): an engagement, a lane write, a safety rule
    // or a byline change. The cached rows still render first.
    useEffect(() => {
        if (!active) return;
        const state = queryClient.getQueryState(queryKey);
        if (state?.data === undefined || state.fetchStatus !== 'idle') return;
        const stale = feed.type === 'replies' || isFeedReadStale(feed, state.dataUpdatedAt);
        if (stale) void reload();
    }, [active, queryClient, queryKey, feed, reload]);

    // A changed `reloadKey` (a reselect of the place the reader is on) reads
    // the feed again. The first value is the mount, which loads on its own.
    const reloadKeyRef = useRef(reloadKey);
    useEffect(() => {
        if (reloadKeyRef.current === reloadKey) return;
        reloadKeyRef.current = reloadKey;
        if (active) void reload();
    }, [reloadKey, active, reload]);

    useReloadOnFeedRuleChange(active, reload);

    // Federated profile still syncing: read page 1 again on the bounded backoff
    // until posts arrive or the budget runs out. Every pending answer is a new
    // read (`dataUpdatedAt`), which arms the next poll; a feed of its own starts
    // with the whole budget.
    const pending = active && pages?.[0]?.pending === true;
    const pendingPolls = useRef({ queryKey, count: 0 });
    useEffect(() => {
        if (pendingPolls.current.queryKey !== queryKey) {
            pendingPolls.current = { queryKey, count: 0 };
        }
        const polls = pendingPolls.current;
        if (!pending) {
            polls.count = 0;
            return;
        }
        const delay = FED_PENDING_POLL_DELAYS_MS[polls.count];
        if (delay === undefined) {
            logger.debug('Pending poll budget exhausted, showing empty state');
            return;
        }
        const timer = setTimeout(() => {
            polls.count += 1;
            void reload();
        }, delay);
        return () => clearTimeout(timer);
    }, [pending, dataUpdatedAt, queryKey, reload]);

    const refresh = useCallback(async () => {
        if (active) await reload();
    }, [active, reload]);

    // The query loads itself when it mounts and when its identity changes, so
    // only a forced call (the empty state's retry) has anything to ask for.
    const fetchInitial = useCallback(
        (forceRefresh: boolean = false) => (forceRefresh ? refresh() : Promise.resolve()),
        [refresh],
    );

    const loadMore = useCallback(async () => {
        if (!active || !hasNextPage) return;
        // `cancelRefetch: false`: while ANY read of this feed is in flight — a
        // first page included — this joins it rather than cancelling it.
        // `onEndReached` can fire from a render that predates that read.
        await fetchNextPage({ cancelRefetch: false });
    }, [active, hasNextPage, fetchNextPage]);

    // Like the read it replaced, a failure is reported only while nothing is in
    // flight: the next read of the feed is what clears it, so there is no error
    // of the query's own to clear here.
    const clearError = useCallback(() => undefined, []);

    const failure = active && error && !isFetching ? classifyFeedFailure(error) : null;

    return {
        items: content.items,
        slices: content.slices,
        interstitials: content.interstitials,
        hasMore: hasNextPage,
        isLoading: !viewerReady || isFetching,
        // A marker, not the transport's message: nothing renders it — the empty
        // state owns its own copy, chosen by `errorKind`.
        error: failure ? 'Failed to load' : null,
        errorKind: failure?.kind ?? null,
        pending,
        fetchInitial,
        refresh,
        loadMore,
        clearError,
    };
}
