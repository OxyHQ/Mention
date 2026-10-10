import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import type { HydratedPost } from '@mention/shared-types';
import { feedService } from '@/services/feedService';
import {
    clearAllFeedMemoryCaches,
    publishNewLocalPost,
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

function post(id: string): HydratedPost {
    return { id, user: { id: `author-${id}` } } as unknown as HydratedPost;
}

let latest: UseFeedStateReturn | undefined;

function Probe({ options }: { options: UseFeedStateOptions }) {
    latest = useFeedState(options);
    return null;
}

const getFeedMock = feedService.getFeed as jest.Mock;
const getUserFeedMock = feedService.getUserFeed as jest.Mock;

/**
 * A post the viewer publishes reaches the RETAINED slice of every feed it belongs
 * in, mounted or not. On web the composer replaces the home feed, so the feed is
 * unmounted at the moment of publishing and warm-starts from that slice when the
 * viewer comes back — it used to come back without the post.
 */
describe("useFeedState: the viewer's own new post", () => {
    const homeOptions: UseFeedStateOptions = {
        type: 'for_you',
        isAuthenticated: true,
        currentUserId: 'viewer-a',
    };
    const homeKey = buildFeedScrollKey({ type: 'for_you', isAuthenticated: true, currentViewerId: 'viewer-a' });

    beforeAll(() => {
        (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    });

    beforeEach(() => {
        latest = undefined;
        jest.clearAllMocks();
        clearAllFeedMemoryCaches();
    });

    async function mount(options: UseFeedStateOptions): Promise<TestRenderer.ReactTestRenderer> {
        let renderer!: TestRenderer.ReactTestRenderer;
        await act(async () => {
            renderer = TestRenderer.create(<Probe options={options} />);
        });
        return renderer;
    }

    it('is at the top of a home feed that was unmounted while it was published', async () => {
        setFeedMemoryCache(homeKey, { items: [post('p1'), post('p2')], hasMore: false, retainedAt: Date.now() });
        const home = await mount(homeOptions);
        act(() => home.unmount());

        // The viewer is on the composer: the home feed is not mounted.
        act(() => publishNewLocalPost(post('mine')));

        const back = await mount(homeOptions);
        expect(latest?.items.map((item) => item.id)).toEqual(['mine', 'p1', 'p2']);
        // Warm-started from the retained slice, not refetched.
        expect(getFeedMock).not.toHaveBeenCalled();
        act(() => back.unmount());
    });

    it('is the first slice of a feed that renders by slice (the web home feed)', async () => {
        const slice = (id: string) => ({
            _sliceKey: `s-${id}`,
            isIncompleteThread: false,
            items: [{ post: post(id), isThreadParent: false, isThreadChild: false, isThreadLastChild: false }],
        });
        setFeedMemoryCache(homeKey, {
            items: [post('p1')],
            slices: [slice('p1')],
            hasMore: false,
            retainedAt: Date.now(),
        });
        const home = await mount(homeOptions);
        act(() => home.unmount());

        act(() => publishNewLocalPost(post('mine')));

        const back = await mount(homeOptions);
        expect(latest?.slices?.map((s) => s.items.map((si) => si.post.id))).toEqual([['mine'], ['p1']]);
        act(() => back.unmount());
    });

    it('is at the top of a mounted home feed exactly once', async () => {
        setFeedMemoryCache(homeKey, { items: [post('p1')], hasMore: false, retainedAt: Date.now() });
        const home = await mount(homeOptions);

        act(() => publishNewLocalPost(post('mine')));
        expect(latest?.items.map((item) => item.id)).toEqual(['mine', 'p1']);

        act(() => home.unmount());
        const back = await mount(homeOptions);
        expect(latest?.items.map((item) => item.id)).toEqual(['mine', 'p1']);
        act(() => back.unmount());
    });

    it("reaches a retained profile feed only when it is that profile's author", async () => {
        const profileOptions: UseFeedStateOptions = {
            type: 'posts',
            userId: 'author-mine',
            isAuthenticated: true,
            currentUserId: 'viewer-a',
        };
        const profileKey = buildFeedScrollKey({
            type: 'posts',
            userId: 'author-mine',
            isAuthenticated: true,
            currentViewerId: 'viewer-a',
        });
        setFeedMemoryCache(profileKey, { items: [post('old')], hasMore: false, retainedAt: Date.now() });
        const profile = await mount(profileOptions);
        act(() => profile.unmount());

        act(() => publishNewLocalPost(post('elsewhere')));
        act(() => publishNewLocalPost(post('mine')));

        const back = await mount(profileOptions);
        expect(latest?.items.map((item) => item.id)).toEqual(['mine', 'old']);
        expect(getUserFeedMock).not.toHaveBeenCalled();
        act(() => back.unmount());
    });

    it("does not carry one viewer's posts into the next viewer's feeds", async () => {
        setFeedMemoryCache(homeKey, { items: [post('p1')], hasMore: false, retainedAt: Date.now() });
        const home = await mount(homeOptions);
        act(() => home.unmount());

        // Account switch.
        clearAllFeedMemoryCaches();
        setFeedMemoryCache(homeKey, { items: [post('p1')], hasMore: false, retainedAt: Date.now() });
        act(() => publishNewLocalPost(post('mine')));

        const back = await mount(homeOptions);
        expect(latest?.items.map((item) => item.id)).toEqual(['p1']);
        act(() => back.unmount());
    });
});
