import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import type { HydratedPost, SlicedFeedResponse } from '@mention/shared-types';
import { feedService } from '@/services/feedService';
import {
    clearAllFeedMemoryCaches,
    setFeedMemoryCache,
} from '@/stores/feedScrollStore';
import { buildFeedScrollKey } from '@/utils/feedUtils';
import {
    useFeedState,
    type UseFeedStateOptions,
    type UseFeedStateReturn,
} from '../useFeedState';

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

jest.mock('@oxyhq/core/logger', () => ({
    ...jest.requireActual('@oxyhq/core/logger'),
    createLogger: () => ({
        debug: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
    }),
}));

jest.mock('@/lib/precacheActorsFromPosts', () => ({
    precacheActorsFromPosts: jest.fn(),
}));

function post(id: string): HydratedPost {
    return { id, user: { id: `author-${id}` } } as unknown as HydratedPost;
}

function page(
    ids: string[],
    nextCursor?: string,
    hasMore: boolean = Boolean(nextCursor),
): SlicedFeedResponse {
    return {
        items: ids.map(post),
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

const defaultOptions: UseFeedStateOptions = {
    type: 'explore',
    useScoped: true,
    isAuthenticated: true,
    currentUserId: 'viewer-a',
};

function Probe({ options = defaultOptions }: { options?: UseFeedStateOptions }) {
    latest = useFeedState(options);
    return null;
}

const getFeedMock = feedService.getFeed as jest.Mock;

async function flush(): Promise<void> {
    await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
    });
}

describe('useFeedState memory-mode retention and request ownership', () => {
    beforeAll(() => {
        (
            globalThis as typeof globalThis & {
                IS_REACT_ACT_ENVIRONMENT?: boolean;
            }
        ).IS_REACT_ACT_ENVIRONMENT = true;
    });

    beforeEach(() => {
        latest = undefined;
        jest.clearAllMocks();
        clearAllFeedMemoryCaches();
    });

    it('warm-starts on every remount for the same viewer without refetching page 1', async () => {
        const feedScrollKey = buildFeedScrollKey({
            type: 'explore',
            isAuthenticated: true,
            currentViewerId: 'viewer-a',
        });
        setFeedMemoryCache(feedScrollKey, {
            items: [post('p1'), post('p2'), post('p3')],
            hasMore: true,
            nextCursor: 'cursor-3',
        });

        let first!: TestRenderer.ReactTestRenderer;
        await act(async () => {
            first = TestRenderer.create(<Probe />);
        });

        expect(latest?.items.map((item) => item.id)).toEqual(['p1', 'p2', 'p3']);
        expect(latest?.nextCursor).toBe('cursor-3');
        expect(getFeedMock).not.toHaveBeenCalled();

        act(() => first.unmount());

        let second!: TestRenderer.ReactTestRenderer;
        await act(async () => {
            second = TestRenderer.create(<Probe />);
        });

        expect(latest?.items.map((item) => item.id)).toEqual(['p1', 'p2', 'p3']);
        expect(latest?.nextCursor).toBe('cursor-3');
        expect(getFeedMock).not.toHaveBeenCalled();

        act(() => second.unmount());
    });

    it('aborts and ignores stale pagination when refresh starts, even if transport resolves late', async () => {
        const stalePage = deferred<SlicedFeedResponse>();
        const refreshedPage = deferred<SlicedFeedResponse>();
        const currentPage = deferred<SlicedFeedResponse>();
        getFeedMock
            .mockResolvedValueOnce(page(['p1'], 'cursor-1'))
            .mockImplementationOnce(() => stalePage.promise)
            .mockImplementationOnce(() => refreshedPage.promise)
            .mockImplementationOnce(() => currentPage.promise);

        let renderer!: TestRenderer.ReactTestRenderer;
        await act(async () => {
            renderer = TestRenderer.create(<Probe />);
        });
        await flush();
        expect(latest?.items.map((item) => item.id)).toEqual(['p1']);

        let loadMorePromise!: Promise<void>;
        act(() => {
            loadMorePromise = latest!.loadMore();
        });
        await flush();
        expect(getFeedMock).toHaveBeenCalledTimes(2);

        let refreshPromise!: Promise<void>;
        act(() => {
            refreshPromise = latest!.refresh();
        });
        await flush();
        expect(getFeedMock).toHaveBeenCalledTimes(3);
        expect(getFeedMock.mock.calls[1][1].signal.aborted).toBe(true);

        // onEndReached can fire from the old render before localLoading commits;
        // the synchronous primary gate must prevent a fourth request.
        await act(async () => {
            await latest!.loadMore();
        });
        expect(getFeedMock).toHaveBeenCalledTimes(3);

        refreshedPage.resolve(page(['fresh'], 'fresh-cursor'));
        await act(async () => {
            await refreshPromise;
        });
        expect(latest?.items.map((item) => item.id)).toEqual(['fresh']);

        let currentLoadMorePromise!: Promise<void>;
        act(() => {
            currentLoadMorePromise = latest!.loadMore();
        });
        await flush();
        expect(getFeedMock).toHaveBeenCalledTimes(4);

        // This mock deliberately ignores AbortSignal and resolves while the
        // current generation's loadMore is active.
        stalePage.resolve(page(['stale-page-2'], 'cursor-2'));
        await act(async () => {
            await loadMorePromise;
        });

        // The stale request's finally must not clear the current ownership gate.
        await act(async () => {
            await latest!.loadMore();
        });
        expect(getFeedMock).toHaveBeenCalledTimes(4);

        currentPage.resolve(page(['fresh-page-2'], 'fresh-cursor-2'));
        await act(async () => {
            await currentLoadMorePromise;
        });
        expect(latest?.items.map((item) => item.id)).toEqual([
            'fresh',
            'fresh-page-2',
        ]);
        expect(latest?.nextCursor).toBe('fresh-cursor-2');

        act(() => renderer.unmount());
    });
});
