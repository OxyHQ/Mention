/**
 * Memory mode — every feed on web, and every scoped feed on native — is one
 * React Query infinite query per feed. The query cache is the retention: a
 * remount renders the cached pages synchronously and requests nothing, unless a
 * write the feed cannot see has happened since its read; then it reads page 1
 * again, and only page 1.
 *
 * Every request is counted here, because the request count IS the behaviour: a
 * warm start that refetches, a refresh that reads every loaded page again, or a
 * load-more that double-fires all render the same rows in the end.
 */
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { QueryClientProvider } from '@tanstack/react-query';
import type { HydratedPost, SlicedFeedResponse } from '@mention/shared-types';
import { feedService } from '@/services/feedService';
import { usePostsStore } from '@/stores/postsStore';
import { queryClient } from '@/lib/queryClient';
import { viewerQueryKeys } from '@/lib/viewerQueryKeys';
import { precacheActorsFromPosts } from '@/lib/precacheActorsFromPosts';
import { isDbAvailable } from '@/db';
import { resetEngagementInvalidation } from '@/stores/engagementInvalidation';
import { noteLaneListsChanged, resetLaneInvalidation } from '@/stores/laneInvalidation';
import { invalidateSafetyFilters, resetSafetyInvalidation } from '@/stores/safetyInvalidation';
import { resetBylineInvalidation } from '@/stores/bylineInvalidation';
import {
    useFeedState,
    type UseFeedStateOptions,
    type UseFeedStateReturn,
} from '../useFeedState';
import { FED_PENDING_POLL_DELAYS_MS } from '../useFeedQuery';

(globalThis as { __DEV__?: boolean }).__DEV__ = false;

jest.mock('@/stores/postsStore', () => {
    const state = {
        fetchFeed: jest.fn(() => Promise.resolve()),
        fetchUserFeed: jest.fn(() => Promise.resolve({ pending: false })),
        refreshFeed: jest.fn(() => Promise.resolve()),
        loadMoreFeed: jest.fn(() => Promise.resolve()),
        cachePosts: jest.fn(),
        clearFeed: jest.fn(),
        clearUserFeed: jest.fn(),
        clearError: jest.fn(),
        feedUI: {},
    };
    const usePostsStore = (selector: (value: typeof state) => unknown) =>
        selector(state);
    usePostsStore.getState = () => state;
    return {
        usePostsStore,
        useFeedSelector: () => undefined,
        useUserFeedSelector: () => undefined,
    };
});

jest.mock('@/services/feedService', () => ({
    feedService: {
        getFeed: jest.fn(),
        getUserFeed: jest.fn(),
    },
}));

jest.mock('@/db', () => ({
    buildFeedKey: jest.fn(() => 'feed-key'),
    hasFeedData: jest.fn(() => false),
    isDbAvailable: jest.fn(() => false),
}));

jest.mock('@oxy.so/core/logger', () => ({
    ...jest.requireActual('@oxy.so/core/logger'),
    createLogger: () => ({
        debug: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
    }),
}));

jest.mock('@/lib/precacheActorsFromPosts', () => ({
    precacheActorsFromPosts: jest.fn(),
}));

function post(id: string, extra: Partial<HydratedPost> = {}): HydratedPost {
    return { id, user: { id: `author-${id}` }, ...extra } as unknown as HydratedPost;
}

function page(
    ids: string[],
    nextCursor?: string,
    hasMore: boolean = Boolean(nextCursor),
): SlicedFeedResponse {
    return {
        items: ids.map((id) => post(id)),
        slices: [],
        interstitials: [],
        hasMore,
        nextCursor,
        totalCount: ids.length,
    };
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

let latest: UseFeedStateReturn | undefined;
/** Every render of the mounted hook, in order — `renders[0]` is the first paint. */
let renders: UseFeedStateReturn[] = [];

const explore: UseFeedStateOptions = {
    type: 'explore',
    useScoped: true,
    isAuthenticated: true,
    currentUserId: 'viewer-a',
};

function Probe({ options }: { options: UseFeedStateOptions }) {
    latest = useFeedState(options);
    renders.push(latest);
    return null;
}

function tree(options: UseFeedStateOptions) {
    return (
        <QueryClientProvider client={queryClient}>
            <Probe options={options} />
        </QueryClientProvider>
    );
}

const getFeedMock = feedService.getFeed as jest.Mock;
const getUserFeedMock = feedService.getUserFeed as jest.Mock;
const isDbAvailableMock = isDbAvailable as jest.Mock;

async function flush(): Promise<void> {
    for (let i = 0; i < 3; i += 1) {
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 0));
        });
    }
}

const open = new Set<TestRenderer.ReactTestRenderer>();

async function mount(options: UseFeedStateOptions = explore): Promise<TestRenderer.ReactTestRenderer> {
    renders = [];
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
        renderer = TestRenderer.create(tree(options));
    });
    await flush();
    open.add(renderer);
    return renderer;
}

function unmount(renderer: TestRenderer.ReactTestRenderer): void {
    act(() => renderer.unmount());
    open.delete(renderer);
}

function ids(state: UseFeedStateReturn | undefined = latest): string[] {
    return (state?.items ?? []).map((item) => item.id);
}

async function loadMore(): Promise<void> {
    await act(async () => {
        await latest!.loadMore();
    });
    await flush();
}

/** Load explore across two pages, the way a reader scrolling it would. */
async function loadTwoPages(): Promise<TestRenderer.ReactTestRenderer> {
    getFeedMock
        .mockResolvedValueOnce(page(['p1', 'p2'], 'cursor-2'))
        .mockResolvedValueOnce(page(['p3'], 'cursor-3'));
    const renderer = await mount();
    await loadMore();
    expect(ids()).toEqual(['p1', 'p2', 'p3']);
    expect(getFeedMock).toHaveBeenCalledTimes(2);
    return renderer;
}

describe('useFeedState memory mode: one feed query', () => {
    beforeAll(() => {
        (
            globalThis as typeof globalThis & {
                IS_REACT_ACT_ENVIRONMENT?: boolean;
            }
        ).IS_REACT_ACT_ENVIRONMENT = true;
    });

    beforeEach(() => {
        latest = undefined;
        renders = [];
        jest.clearAllMocks();
        queryClient.clear();
        resetEngagementInvalidation();
        resetLaneInvalidation();
        resetSafetyInvalidation();
        resetBylineInvalidation();
        isDbAvailableMock.mockReturnValue(false);
    });

    afterEach(() => {
        for (const renderer of open) {
            act(() => renderer.unmount());
        }
        open.clear();
        jest.useRealTimers();
    });

    describe('warm start', () => {
        it('renders every loaded page on the FIRST paint of a remount, and requests nothing', async () => {
            const first = await loadTwoPages();
            unmount(first);

            await mount();

            // Synchronous: Bloom's web scroll restoration lands on these rows.
            expect(ids(renders[0])).toEqual(['p1', 'p2', 'p3']);
            expect(renders[0].isLoading).toBe(false);
            expect(latest?.nextCursor).toBe('cursor-3');
            expect(getFeedMock).toHaveBeenCalledTimes(2);
        });

        it('reads page 1 alone again when a write it cannot see postdates its read', async () => {
            const first = await loadTwoPages();
            unmount(first);

            invalidateSafetyFilters();
            getFeedMock.mockResolvedValueOnce(page(['fresh'], 'fresh-2'));
            await mount();

            // The cached rows still paint first — no flash…
            expect(ids(renders[0])).toEqual(['p1', 'p2', 'p3']);
            // …and ONE request, for page 1: never every loaded page.
            expect(getFeedMock).toHaveBeenCalledTimes(3);
            expect(getFeedMock.mock.calls[2][0].cursor).toBeUndefined();
            expect(ids()).toEqual(['fresh']);
            expect(latest?.nextCursor).toBe('fresh-2');
        });

        it('asks the lane authority too, with the feed\'s own lane', async () => {
            const laneFeed: UseFeedStateOptions = { ...explore, type: 'posts', filters: { laneId: 'lane-1' } };
            getFeedMock.mockResolvedValueOnce(page(['l1']));
            unmount(await mount(laneFeed));

            noteLaneListsChanged('mute');
            getFeedMock.mockResolvedValueOnce(page(['l2']));
            await mount(laneFeed);

            expect(getFeedMock).toHaveBeenCalledTimes(2);
            expect(ids()).toEqual(['l2']);
        });

        it('always reads a thread\'s replies again, page 1 only', async () => {
            const thread: UseFeedStateOptions = {
                ...explore,
                type: 'replies',
                filters: { postId: 'root', parentPostId: 'root' },
            };
            const reply = (id: string) => post(id, { parentPostId: 'root' } as Partial<HydratedPost>);
            getFeedMock
                .mockResolvedValueOnce({ ...page([], 'r-2'), items: [reply('r1')] })
                .mockResolvedValueOnce({ ...page([], 'r-3'), items: [reply('r2')] });
            const first = await mount(thread);
            await loadMore();
            unmount(first);

            getFeedMock.mockResolvedValueOnce({ ...page([]), items: [reply('r1'), reply('r9')] });
            await mount(thread);

            expect(ids(renders[0])).toEqual(['r1', 'r2']);
            expect(getFeedMock).toHaveBeenCalledTimes(3);
            expect(getFeedMock.mock.calls[2][0].cursor).toBeUndefined();
            expect(ids()).toEqual(['r1', 'r9']);
        });

        it('narrows a thread to the replies that answer it, and seeds the entity caches', async () => {
            getFeedMock.mockResolvedValueOnce({
                ...page([]),
                items: [
                    post('answer', { parentPostId: 'root' } as Partial<HydratedPost>),
                    post('elsewhere', { parentPostId: 'other' } as Partial<HydratedPost>),
                ],
            });
            await mount({ ...explore, type: 'replies', filters: { parentPostId: 'root' } });

            expect(ids()).toEqual(['answer']);
            const cachePosts = usePostsStore.getState().cachePosts as jest.Mock;
            expect(cachePosts.mock.calls[0][0].map((item: HydratedPost) => item.id)).toEqual(['answer']);
            expect((precacheActorsFromPosts as jest.Mock).mock.calls[0][0].map((item: HydratedPost) => item.id))
                .toEqual(['answer']);
        });
    });

    describe('viewer isolation', () => {
        it('never shows one viewer\'s cached feed to another', async () => {
            getFeedMock.mockResolvedValueOnce(page(['for-a']));
            unmount(await mount());

            getFeedMock.mockResolvedValueOnce(page(['for-b']));
            await mount({ ...explore, currentUserId: 'viewer-b' });

            expect(ids(renders[0])).toEqual([]);
            expect(renders[0].isLoading).toBe(true);
            expect(getFeedMock).toHaveBeenCalledTimes(2);
            expect(ids()).toEqual(['for-b']);
        });

        it('reads and shows nothing while a signed-in viewer\'s id has not landed', async () => {
            getFeedMock.mockResolvedValueOnce(page(['anonymous-row']));
            unmount(await mount({ ...explore, isAuthenticated: false, currentUserId: undefined }));

            await mount({ ...explore, isAuthenticated: true, currentUserId: undefined });

            expect(ids()).toEqual([]);
            expect(latest?.isLoading).toBe(true);
            expect(getFeedMock).toHaveBeenCalledTimes(1);
            // Nothing a caller does can read it under no viewer either.
            await act(async () => {
                await latest!.refresh();
                await latest!.fetchInitial(true);
                await latest!.loadMore();
            });
            expect(getFeedMock).toHaveBeenCalledTimes(1);
        });
    });

    describe('refresh and reload', () => {
        it('refreshes with ONE request for page 1, however many pages are loaded', async () => {
            await loadTwoPages();

            getFeedMock.mockResolvedValueOnce(page(['fresh'], 'fresh-2'));
            await act(async () => {
                await latest!.refresh();
            });
            await flush();

            expect(getFeedMock).toHaveBeenCalledTimes(3);
            expect(getFeedMock.mock.calls[2][0].cursor).toBeUndefined();
            expect(ids()).toEqual(['fresh']);
            expect(latest?.hasMore).toBe(true);
        });

        it('keeps the loaded rows on screen while the refresh is in flight', async () => {
            await loadTwoPages();
            const refreshed = deferred<SlicedFeedResponse>();
            getFeedMock.mockImplementationOnce(() => refreshed.promise);

            act(() => {
                void latest!.refresh();
            });
            await flush();
            expect(ids()).toEqual(['p1', 'p2', 'p3']);
            expect(latest?.isLoading).toBe(true);

            refreshed.resolve(page(['fresh']));
            await flush();
            expect(ids()).toEqual(['fresh']);
            expect(latest?.isLoading).toBe(false);
        });

        it('reads page 1 again when the reload key changes, and not for the first one', async () => {
            const reloadable: UseFeedStateOptions = { ...explore, reloadKey: 1 };
            getFeedMock.mockResolvedValue(page(['p1']));
            const renderer = await mount(reloadable);
            expect(getFeedMock).toHaveBeenCalledTimes(1);

            await act(async () => {
                renderer.update(tree({ ...reloadable, reloadKey: 2 }));
            });
            await flush();

            expect(getFeedMock).toHaveBeenCalledTimes(2);
            expect(getFeedMock.mock.calls[1][0].cursor).toBeUndefined();
        });

        it('only reads again from fetchInitial when forced', async () => {
            getFeedMock.mockResolvedValue(page(['p1']));
            await mount();

            await act(async () => {
                await latest!.fetchInitial();
            });
            expect(getFeedMock).toHaveBeenCalledTimes(1);

            await act(async () => {
                await latest!.fetchInitial(true);
            });
            await flush();
            expect(getFeedMock).toHaveBeenCalledTimes(2);
        });
    });

    describe('load more', () => {
        it('asks for the next cursor once, and not at all past the last page', async () => {
            await loadTwoPages();
            expect(getFeedMock.mock.calls[1][0].cursor).toBe('cursor-2');

            // `cursor-3` came with `hasMore` — one more page, which is the end.
            getFeedMock.mockResolvedValueOnce(page(['p4']));
            await loadMore();
            expect(getFeedMock).toHaveBeenCalledTimes(3);
            expect(latest?.hasMore).toBe(false);

            await loadMore();
            expect(getFeedMock).toHaveBeenCalledTimes(3);
        });

        it('treats a page that hands back the cursor it was read with as the end', async () => {
            getFeedMock
                .mockResolvedValueOnce(page(['p1'], 'cursor-2'))
                .mockResolvedValueOnce(page(['p2'], 'cursor-2'));
            await mount();
            await loadMore();

            expect(latest?.hasMore).toBe(false);
            await loadMore();
            expect(getFeedMock).toHaveBeenCalledTimes(2);
        });

        it('fires one request for two load-mores in a row', async () => {
            getFeedMock.mockResolvedValueOnce(page(['p1'], 'cursor-2'));
            await mount();
            const second = deferred<SlicedFeedResponse>();
            getFeedMock.mockImplementationOnce(() => second.promise);

            await act(async () => {
                void latest!.loadMore();
                void latest!.loadMore();
            });
            expect(getFeedMock).toHaveBeenCalledTimes(2);

            second.resolve(page(['p2']));
            await flush();
            expect(ids()).toEqual(['p1', 'p2']);
        });

        it('joins a first-page read in flight instead of firing beside it', async () => {
            getFeedMock.mockResolvedValueOnce(page(['p1'], 'cursor-2'));
            await mount();
            const refreshed = deferred<SlicedFeedResponse>();
            getFeedMock.mockImplementationOnce(() => refreshed.promise);

            act(() => {
                void latest!.refresh();
            });
            await flush();
            // `onEndReached` from a render that predates the refresh.
            await act(async () => {
                void latest!.loadMore();
            });
            expect(getFeedMock).toHaveBeenCalledTimes(2);

            refreshed.resolve(page(['fresh']));
            await flush();
            expect(ids()).toEqual(['fresh']);
        });

        it('drops a load-more a refresh superseded, even if its transport answers late', async () => {
            getFeedMock.mockResolvedValueOnce(page(['p1'], 'cursor-2'));
            await mount();
            const stalePage = deferred<SlicedFeedResponse>();
            getFeedMock.mockImplementationOnce(() => stalePage.promise);

            await act(async () => {
                void latest!.loadMore();
            });
            expect(getFeedMock).toHaveBeenCalledTimes(2);

            getFeedMock.mockResolvedValueOnce(page(['fresh'], 'fresh-2'));
            await act(async () => {
                await latest!.refresh();
            });
            await flush();
            expect(getFeedMock.mock.calls[1][1].signal.aborted).toBe(true);
            expect(ids()).toEqual(['fresh']);

            // This transport ignores its AbortSignal and resolves anyway.
            stalePage.resolve(page(['stale-page-2'], 'cursor-3'));
            await flush();
            expect(ids()).toEqual(['fresh']);
            expect(latest?.nextCursor).toBe('fresh-2');
        });
    });

    describe('failures — the retry policy is the feed service\'s', () => {
        it('asks the feed service exactly once for a failed load', async () => {
            // The hook used to wrap every fetch in four attempts of its own on top
            // of the service's, so one failed load could cost 16 requests. The
            // query calls the service once and lets `utils/feedRetry` own the
            // budget — and the client's default retry must not come back either.
            getFeedMock.mockRejectedValue({ message: 'HTTP 500 error', status: 500 });

            await mount();
            await flush();

            expect(getFeedMock).toHaveBeenCalledTimes(1);
            expect(latest?.error).toBe('Failed to load');
            // Classified from the status the error carried, never from its message.
            expect(latest?.errorKind).toBe('transient');
            expect(latest?.isLoading).toBe(false);
        });

        it('reports an unanswered request as offline so the empty state can say so', async () => {
            getFeedMock.mockRejectedValue({ message: 'Network error', code: 'NETWORK_ERROR', status: 0 });

            await mount();

            expect(latest?.errorKind).toBe('offline');
        });

        it('keeps the rows and clears the error once the retry succeeds', async () => {
            getFeedMock.mockRejectedValueOnce({ status: 503 }).mockResolvedValueOnce(page(['p1']));
            await mount();
            expect(latest?.error).toBe('Failed to load');

            await act(async () => {
                latest!.clearError();
                await latest!.fetchInitial(true);
            });
            await flush();

            expect(ids()).toEqual(['p1']);
            expect(latest?.error).toBeNull();
            expect(latest?.errorKind).toBeNull();
        });

        it('keeps the loaded rows when a refresh or a next page fails', async () => {
            getFeedMock.mockResolvedValueOnce(page(['p1'], 'cursor-2'));
            await mount();

            getFeedMock.mockRejectedValueOnce({ status: 500 });
            await loadMore();
            expect(ids()).toEqual(['p1']);
            expect(latest?.error).toBe('Failed to load more posts');

            getFeedMock.mockRejectedValueOnce({ status: 500 });
            await act(async () => {
                await latest!.refresh();
            });
            await flush();
            expect(ids()).toEqual(['p1']);
            expect(latest?.error).toBe('Failed to refresh');
        });
    });

    describe('federated profile still syncing', () => {
        const remote: UseFeedStateOptions = {
            type: 'posts',
            userId: 'remote-author',
            isAuthenticated: true,
            currentUserId: 'viewer-a',
        };
        const pendingPage = (): SlicedFeedResponse => ({ ...page([]), pending: true });

        async function advance(ms: number): Promise<void> {
            await act(async () => {
                await jest.advanceTimersByTimeAsync(ms);
            });
        }

        // React Query hands a read's result to its observers on a timer (which
        // Node clamps to 1ms), and the effect that arms the next poll runs when
        // that render commits. So a poll is asserted inside a small window
        // around its delay rather than to the millisecond.
        const SLACK_MS = 10;

        async function mountRemote(): Promise<void> {
            let renderer!: TestRenderer.ReactTestRenderer;
            await act(async () => {
                renderer = TestRenderer.create(tree(remote));
            });
            open.add(renderer);
            await advance(SLACK_MS);
        }

        it('re-polls page 1 on the bounded 1s / 2.5s / 5s budget, then stops', async () => {
            jest.useFakeTimers();
            getUserFeedMock.mockResolvedValue(pendingPage());

            // Measured from the mount: each poll is armed when the read before it
            // lands, so the delays add up.
            let elapsed = SLACK_MS;
            const advanceTo = async (ms: number): Promise<void> => {
                await advance(ms - elapsed);
                elapsed = ms;
            };
            await mountRemote();
            expect(getUserFeedMock).toHaveBeenCalledTimes(1);
            expect(latest?.pending).toBe(true);

            let due = 0;
            for (const [index, delay] of FED_PENDING_POLL_DELAYS_MS.entries()) {
                due += delay;
                await advanceTo(due - SLACK_MS);
                expect(getUserFeedMock).toHaveBeenCalledTimes(index + 1);
                await advanceTo(due + SLACK_MS);
                expect(getUserFeedMock).toHaveBeenCalledTimes(index + 2);
                expect(getUserFeedMock.mock.calls[index + 1][1].cursor).toBeUndefined();
            }

            // The budget is spent: the empty state shows, nothing polls on.
            await advance(60_000);
            expect(getUserFeedMock).toHaveBeenCalledTimes(1 + FED_PENDING_POLL_DELAYS_MS.length);
            expect(latest?.pending).toBe(true);
        });

        it('stops polling as soon as posts arrive', async () => {
            jest.useFakeTimers();
            getUserFeedMock
                .mockResolvedValueOnce(pendingPage())
                .mockResolvedValueOnce(page(['synced']));

            await mountRemote();
            await advance(FED_PENDING_POLL_DELAYS_MS[0] + SLACK_MS);

            expect(ids()).toEqual(['synced']);
            expect(latest?.pending).toBe(false);
            await advance(60_000);
            expect(getUserFeedMock).toHaveBeenCalledTimes(2);
        });

        it('keeps a page already on screen when a later read answers pending and empty', async () => {
            jest.useFakeTimers();
            getUserFeedMock
                .mockResolvedValueOnce(page(['shown']))
                .mockResolvedValueOnce(pendingPage())
                .mockResolvedValueOnce(page(['shown', 'newer']));

            await mountRemote();
            expect(ids()).toEqual(['shown']);

            await act(async () => {
                await latest!.refresh();
            });
            await advance(SLACK_MS);
            expect(ids()).toEqual(['shown']);
            expect(latest?.pending).toBe(true);

            await advance(FED_PENDING_POLL_DELAYS_MS[0] + SLACK_MS);
            expect(ids()).toEqual(['shown', 'newer']);
            expect(latest?.pending).toBe(false);
        });
    });

    describe('the SQLite path is untouched', () => {
        it('reads native unscoped feeds through the store and never through a feed query', async () => {
            isDbAvailableMock.mockReturnValue(true);
            const fetchFeed = usePostsStore.getState().fetchFeed as jest.Mock;

            await mount({ ...explore, useScoped: false });

            expect(fetchFeed).toHaveBeenCalledTimes(1);
            expect(getFeedMock).not.toHaveBeenCalled();
            expect(queryClient.getQueryData(viewerQueryKeys.feed('viewer-a', 'explore'))).toBeUndefined();
        });
    });
});
