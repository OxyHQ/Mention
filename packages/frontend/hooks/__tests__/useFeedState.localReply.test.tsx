/**
 * A reply the viewer just posted shows up in the thread it answers, without a
 * pull-to-refresh (OxyHQ/Mention#1140).
 *
 * The thread's replies list is a SCOPED memory feed, which the new-post
 * broadcast skips on purpose; on native the thread screen also stays mounted
 * under the pushed composer, so nothing remounts it. `postsStore.createReply`
 * now publishes the server's hydrated reply, and the replies feed whose scope is
 * that reply's parent puts it on top — and no other feed does.
 */
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import type { HydratedPost, SlicedFeedResponse } from '@mention/shared-types';
import { feedService } from '@/services/feedService';
import {
    clearAllFeedMemoryCaches,
    getFeedMemoryCache,
    publishNewLocalReply,
} from '@/stores/feedScrollStore';
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

function reply(id: string, parentPostId: string): HydratedPost {
    return { id, parentPostId, user: { id: 'viewer-a' } } as unknown as HydratedPost;
}

function page(items: HydratedPost[]): SlicedFeedResponse {
    return {
        items,
        slices: [],
        interstitials: [],
        hasMore: false,
        totalCount: items.length,
    };
}

let latest: UseFeedStateReturn | undefined;

function Probe({ options }: { options: UseFeedStateOptions }) {
    latest = useFeedState(options);
    return null;
}

const threadOptions = (parent: string): UseFeedStateOptions => ({
    type: 'replies',
    filters: { postId: parent, parentPostId: parent },
    useScoped: true,
    isAuthenticated: true,
    currentUserId: 'viewer-a',
});

async function flush(): Promise<void> {
    await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
    });
}

async function mount(options: UseFeedStateOptions): Promise<TestRenderer.ReactTestRenderer> {
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
        renderer = TestRenderer.create(<Probe options={options} />);
    });
    await flush();
    return renderer;
}

describe('useFeedState: the viewer’s own new reply', () => {
    beforeAll(() => {
        (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
            .IS_REACT_ACT_ENVIRONMENT = true;
    });

    beforeEach(() => {
        latest = undefined;
        jest.clearAllMocks();
        clearAllFeedMemoryCaches();
    });

    it('goes on top of the thread it answers, with no refetch', async () => {
        (feedService.getFeed as jest.Mock).mockResolvedValue(page([reply('r1', 'root')]));
        const renderer = await mount(threadOptions('root'));
        expect(latest?.items.map((item) => item.id)).toEqual(['r1']);
        const readsBefore = (feedService.getFeed as jest.Mock).mock.calls.length;

        act(() => publishNewLocalReply(reply('mine', 'root')));

        expect(latest?.items.map((item) => item.id)).toEqual(['mine', 'r1']);
        expect((feedService.getFeed as jest.Mock).mock.calls.length).toBe(readsBefore);
        // And the retained slice agrees, so leaving and coming back keeps it.
        const retained = getFeedMemoryCache(latest!.feedScrollKey);
        expect(retained?.items.map((item) => item.id)).toEqual(['mine', 'r1']);

        act(() => renderer.unmount());
    });

    it('appears in an EMPTY thread — the state the report was about', async () => {
        (feedService.getFeed as jest.Mock).mockResolvedValue(page([]));
        const renderer = await mount(threadOptions('root'));
        expect(latest?.items).toEqual([]);

        act(() => publishNewLocalReply(reply('mine', 'root')));

        expect(latest?.items.map((item) => item.id)).toEqual(['mine']);
        act(() => renderer.unmount());
    });

    it('stays out of a different thread, and is not duplicated', async () => {
        (feedService.getFeed as jest.Mock).mockResolvedValue(page([]));
        const renderer = await mount(threadOptions('other'));

        act(() => publishNewLocalReply(reply('mine', 'root')));
        expect(latest?.items).toEqual([]);

        act(() => publishNewLocalReply(reply('mine-2', 'other')));
        act(() => publishNewLocalReply(reply('mine-2', 'other')));
        expect(latest?.items.map((item) => item.id)).toEqual(['mine-2']);

        act(() => renderer.unmount());
    });

    it('never lands in a feed that is not a replies feed', async () => {
        (feedService.getFeed as jest.Mock).mockResolvedValue(page([]));
        const renderer = await mount({
            type: 'explore',
            filters: { postId: 'root' },
            useScoped: true,
            isAuthenticated: true,
            currentUserId: 'viewer-a',
        });

        act(() => publishNewLocalReply(reply('mine', 'root')));
        expect(latest?.items).toEqual([]);

        act(() => renderer.unmount());
    });
});
