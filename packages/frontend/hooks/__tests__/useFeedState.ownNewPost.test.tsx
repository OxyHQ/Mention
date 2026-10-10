import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { QueryClientProvider } from '@tanstack/react-query';
import type { FeedPostSlice, HydratedPost, SlicedFeedResponse } from '@mention/shared-types';
import { feedService } from '@/services/feedService';
import { queryClient } from '@/lib/queryClient';
import { publishNewLocalPost } from '@/stores/feedQueryCache';
import { getLocalPostRevision } from '@/stores/feedScrollStore';
import { resetEngagementInvalidation } from '@/stores/engagementInvalidation';
import { invalidateSafetyFilters, resetSafetyInvalidation } from '@/stores/safetyInvalidation';
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

/** A post by `author`; the viewer's own new posts are by `viewer-a`. */
function post(id: string, author: string = `author-${id}`): HydratedPost {
    return { id, user: { id: author } } as unknown as HydratedPost;
}

function slice(id: string): FeedPostSlice {
    return {
        _sliceKey: `s-${id}`,
        isIncompleteThread: false,
        items: [{ post: post(id), isThreadParent: false, isThreadChild: false, isThreadLastChild: false }],
    };
}

function page(items: HydratedPost[], slices: FeedPostSlice[] = []): SlicedFeedResponse {
    return { items, slices, interstitials: [], hasMore: false, totalCount: items.length };
}

let latest: UseFeedStateReturn | undefined;

function Probe({ options }: { options: UseFeedStateOptions }) {
    latest = useFeedState(options);
    return null;
}

const getFeedMock = feedService.getFeed as jest.Mock;
const getUserFeedMock = feedService.getUserFeed as jest.Mock;

async function flush(): Promise<void> {
    for (let i = 0; i < 3; i += 1) {
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 0));
        });
    }
}

function ids(): string[] {
    return (latest?.items ?? []).map((item) => item.id);
}

/**
 * A post the viewer publishes reaches every feed it belongs in, mounted or not.
 * On web the composer REPLACES the home feed, so the feed is unmounted at the
 * moment of publishing and warm-starts from its cached pages when the viewer
 * comes back — it used to come back without the post (#1331).
 */
describe("useFeedState: the viewer's own new post", () => {
    const home: UseFeedStateOptions = {
        type: 'for_you',
        isAuthenticated: true,
        currentUserId: 'viewer-a',
    };
    const ownProfile: UseFeedStateOptions = {
        type: 'posts',
        userId: 'viewer-a',
        isAuthenticated: true,
        currentUserId: 'viewer-a',
    };

    beforeAll(() => {
        (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    });

    beforeEach(() => {
        latest = undefined;
        jest.clearAllMocks();
        queryClient.clear();
        resetEngagementInvalidation();
        resetSafetyInvalidation();
    });

    async function mount(options: UseFeedStateOptions): Promise<TestRenderer.ReactTestRenderer> {
        let renderer!: TestRenderer.ReactTestRenderer;
        await act(async () => {
            renderer = TestRenderer.create(
                <QueryClientProvider client={queryClient}>
                    <Probe options={options} />
                </QueryClientProvider>,
            );
        });
        await flush();
        return renderer;
    }

    /** Load a feed once and leave it, as the reader opening the composer does. */
    async function visit(options: UseFeedStateOptions): Promise<void> {
        const renderer = await mount(options);
        act(() => renderer.unmount());
    }

    it('is at the top of a home feed that was unmounted while it was published', async () => {
        getFeedMock.mockResolvedValueOnce(page([post('p1'), post('p2')]));
        await visit(home);

        // The viewer is on the composer: the home feed is not mounted.
        act(() => publishNewLocalPost(post('mine', 'viewer-a')));

        const back = await mount(home);
        expect(ids()).toEqual(['mine', 'p1', 'p2']);
        // Warm-started from the cache, not read again.
        expect(getFeedMock).toHaveBeenCalledTimes(1);
        act(() => back.unmount());
    });

    it('is the first slice of a feed that renders by slice (the web home feed)', async () => {
        getFeedMock.mockResolvedValueOnce(page([post('p1')], [slice('p1')]));
        await visit(home);

        act(() => publishNewLocalPost(post('mine', 'viewer-a')));

        const back = await mount(home);
        expect(latest?.slices?.map((s) => s.items.map((si) => si.post.id))).toEqual([['mine'], ['p1']]);
        act(() => back.unmount());
    });

    it('is at the top of a mounted home feed exactly once', async () => {
        getFeedMock.mockResolvedValueOnce(page([post('p1')]));
        const mounted = await mount(home);

        act(() => publishNewLocalPost(post('mine', 'viewer-a')));
        act(() => publishNewLocalPost(post('mine', 'viewer-a')));
        await flush();
        expect(ids()).toEqual(['mine', 'p1']);

        act(() => mounted.unmount());
        const back = await mount(home);
        expect(ids()).toEqual(['mine', 'p1']);
        expect(getFeedMock).toHaveBeenCalledTimes(1);
        act(() => back.unmount());
    });

    it("reaches its author's own profile posts, and no other profile tab or profile", async () => {
        const ownLikes: UseFeedStateOptions = { ...ownProfile, type: 'likes' };
        const otherProfile: UseFeedStateOptions = { ...ownProfile, userId: 'someone-else' };
        getUserFeedMock.mockImplementation((userId: string, request: { type: string }) =>
            Promise.resolve(page([post(`${userId}-${request.type}`)])));
        await visit(ownProfile);
        await visit(ownLikes);
        await visit(otherProfile);

        act(() => publishNewLocalPost(post('elsewhere', 'someone-else-entirely')));
        act(() => publishNewLocalPost(post('mine', 'viewer-a')));

        const profile = await mount(ownProfile);
        expect(ids()).toEqual(['mine', 'viewer-a-posts']);
        act(() => profile.unmount());

        const likes = await mount(ownLikes);
        expect(ids()).toEqual(['viewer-a-likes']);
        act(() => likes.unmount());

        const other = await mount(otherProfile);
        expect(ids()).toEqual(['someone-else-posts']);
        act(() => other.unmount());

        expect(getUserFeedMock).toHaveBeenCalledTimes(3);
    });

    it('never reaches a scoped feed', async () => {
        const hashtag: UseFeedStateOptions = { ...home, type: 'hashtag', filters: { hashtag: 'news' }, useScoped: true };
        getFeedMock.mockResolvedValueOnce(page([post('tagged')]));
        const mounted = await mount(hashtag);

        act(() => publishNewLocalPost(post('mine', 'viewer-a')));
        await flush();

        expect(ids()).toEqual(['tagged']);
        act(() => mounted.unmount());
    });

    it('does not make a feed read before a write look fresher than it is', async () => {
        getFeedMock.mockResolvedValueOnce(page([post('p1')]));
        await visit(home);

        invalidateSafetyFilters();
        // Publish strictly AFTER the rule change: stamped with its own time, the
        // write would then look newer than the change and hide it.
        await new Promise((resolve) => setTimeout(resolve, 5));
        act(() => publishNewLocalPost(post('mine', 'viewer-a')));

        // The post went in, but the read under it still predates the rule
        // change, so the warm start reads page 1 again.
        getFeedMock.mockResolvedValueOnce(page([post('mine', 'viewer-a'), post('fresh')]));
        const back = await mount(home);
        expect(getFeedMock).toHaveBeenCalledTimes(2);
        expect(ids()).toEqual(['mine', 'fresh']);
        act(() => back.unmount());
    });

    it('advances the revision the feed brings it into view by', () => {
        const before = getLocalPostRevision();
        act(() => publishNewLocalPost(post('mine', 'viewer-a')));
        expect(getLocalPostRevision()).toBe(before + 1);
    });

    it("does not carry one viewer's posts into the next viewer's feeds", async () => {
        getFeedMock.mockResolvedValueOnce(page([post('p1')]));
        await visit(home);

        // Account switch: `AccountSwitchReset` clears the whole client.
        queryClient.clear();
        act(() => publishNewLocalPost(post('mine', 'viewer-a')));

        getFeedMock.mockResolvedValueOnce(page([post('for-b')]));
        const next = await mount({ ...home, currentUserId: 'viewer-b' });
        expect(ids()).toEqual(['for-b']);
        act(() => next.unmount());
    });
});
