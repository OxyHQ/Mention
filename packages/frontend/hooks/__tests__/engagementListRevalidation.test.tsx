import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import type { HydratedPost, SlicedFeedResponse } from '@mention/shared-types';
import { feedService } from '@/services/feedService';
import { clearAllFeedMemoryCaches } from '@/stores/feedScrollStore';
import {
    invalidateEngagementLists,
    resetEngagementInvalidation,
} from '@/stores/engagementInvalidation';
import { useFeedState, type UseFeedStateReturn } from '../useFeedState';

/**
 * Liking and boosting must show on the viewer's own likes and boosts tabs the
 * next time those tabs open — with no page reload.
 *
 * Those tabs are `<Feed>` surfaces, and a feed deliberately warm-starts from its
 * retained slice on remount rather than refetching page 1, which is what keeps a
 * deep-scrolled feed from resetting every time the user navigates away and back.
 * That is correct until the viewer changes what the list CONTAINS: no optimistic
 * update can know the server's paging or ordering, so the retained slice is
 * simply out of date and the warm start has to revalidate.
 *
 * The write side of that signal is `postsStore`, which reports every successful
 * engagement to `stores/engagementInvalidation`; the read side is `useFeedState`,
 * which compares the slice's age against it. This file drives the READ side
 * directly through the real hook, so it fails if either half stops honouring the
 * signal. The `saved` half of the same authority is covered against the real
 * screen in `app/(app)/__tests__/savedScreenRevalidation.test.tsx`.
 */

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
    const usePostsStore = (selector: (value: typeof state) => unknown) => selector(state);
    usePostsStore.getState = () => state;
    return {
        usePostsStore,
        useFeedSelector: () => undefined,
        useUserFeedSelector: () => undefined,
    };
});

jest.mock('@/services/feedService', () => ({
    feedService: { getFeed: jest.fn(), getUserFeed: jest.fn() },
}));

// Web has no SQLite, so every feed runs the memory path — the one the profile
// likes and boosts tabs actually use where this was reported.
jest.mock('@/db', () => ({
    buildFeedKey: jest.fn(() => 'feed-key'),
    hasFeedData: jest.fn(() => false),
    isDbAvailable: jest.fn(() => false),
}));

jest.mock('@oxyhq/core/logger', () => ({
    ...jest.requireActual('@oxyhq/core/logger'),
    createLogger: () => ({ debug: jest.fn(), error: jest.fn(), warn: jest.fn() }),
}));

jest.mock('@/lib/precacheActorsFromPosts', () => ({
    precacheActorsFromPosts: jest.fn(),
}));

const VIEWER_ID = 'viewer-a';

/** Post ids the server currently reports for each of the viewer's lists. */
let serverLists: { likes: string[]; boosts: string[] } = { likes: [], boosts: [] };

function page(ids: string[]): SlicedFeedResponse {
    return {
        items: ids.map((id) => ({ id, user: { id: `author-${id}` } }) as unknown as HydratedPost),
        slices: [],
        interstitials: [],
        hasMore: false,
        totalCount: ids.length,
    };
}

let latest: UseFeedStateReturn | undefined;

function ProfileTab({ tab }: { tab: 'likes' | 'boosts' }) {
    latest = useFeedState({
        type: tab,
        userId: VIEWER_ID,
        useScoped: false,
        isAuthenticated: true,
        currentUserId: VIEWER_ID,
    });
    return null;
}

const getUserFeedMock = feedService.getUserFeed as jest.Mock;

async function flush(): Promise<void> {
    await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
    });
}

/** Open a profile tab, as a navigation would: a fresh mount. */
async function openTab(tab: 'likes' | 'boosts'): Promise<TestRenderer.ReactTestRenderer> {
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
        renderer = TestRenderer.create(<ProfileTab tab={tab} />);
    });
    await flush();
    return renderer;
}

function renderedIds(): string[] {
    return (latest?.items ?? []).map((item) => item.id);
}

describe('engagement lists revalidate on their next visit', () => {
    beforeAll(() => {
        (
            globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
        ).IS_REACT_ACT_ENVIRONMENT = true;
    });

    beforeEach(() => {
        latest = undefined;
        jest.clearAllMocks();
        clearAllFeedMemoryCaches();
        resetEngagementInvalidation();
        serverLists = { likes: [], boosts: [] };
        getUserFeedMock.mockImplementation((_userId: string, request: { type: string }) =>
            Promise.resolve(page(request.type === 'boosts' ? serverLists.boosts : serverLists.likes)),
        );
    });

    it('shows a post liked elsewhere on the next visit to the likes tab, with no reload', async () => {
        serverLists.likes = ['post-old'];

        const firstVisit = await openTab('likes');
        expect(renderedIds()).toEqual(['post-old']);
        act(() => firstVisit.unmount());

        // The viewer likes another post from the home feed. `postsStore` reports
        // the successful write; this is the exact call it makes.
        serverLists.likes = ['post-new', 'post-old'];
        invalidateEngagementLists('like');

        const secondVisit = await openTab('likes');
        expect(renderedIds()).toContain('post-new');
        act(() => secondVisit.unmount());
    });

    it('shows a post boosted elsewhere on the next visit to the boosts tab, with no reload', async () => {
        serverLists.boosts = ['post-old'];

        const firstVisit = await openTab('boosts');
        expect(renderedIds()).toEqual(['post-old']);
        act(() => firstVisit.unmount());

        serverLists.boosts = ['post-new', 'post-old'];
        invalidateEngagementLists('boost');

        const secondVisit = await openTab('boosts');
        expect(renderedIds()).toContain('post-new');
        act(() => secondVisit.unmount());
    });

    it('drops an unliked post on the next visit to the likes tab', async () => {
        serverLists.likes = ['post-a', 'post-b'];

        const firstVisit = await openTab('likes');
        expect(renderedIds()).toEqual(['post-a', 'post-b']);
        act(() => firstVisit.unmount());

        serverLists.likes = ['post-b'];
        invalidateEngagementLists('like');

        const secondVisit = await openTab('likes');
        expect(renderedIds()).toEqual(['post-b']);
        act(() => secondVisit.unmount());
    });

    it('still warm-starts without a request when no engagement changed the list', async () => {
        serverLists.likes = ['post-old'];

        const firstVisit = await openTab('likes');
        expect(getUserFeedMock).toHaveBeenCalledTimes(1);
        act(() => firstVisit.unmount());

        // Reopening a list nobody has changed must stay free. This is the property
        // that a blanket "always refetch on mount" would destroy, and the reason
        // the warm start exists at all.
        const secondVisit = await openTab('likes');
        expect(getUserFeedMock).toHaveBeenCalledTimes(1);
        expect(renderedIds()).toEqual(['post-old']);
        act(() => secondVisit.unmount());
    });

    it('leaves another account\'s likes tab alone when the viewer likes something', async () => {
        const OTHER_ID = 'other-profile';
        // A warm start needs a non-empty retained slice; an empty one deliberately
        // never suppresses the cold fetch, which would make this assertion vacuous.
        serverLists.likes = ['their-post'];

        function OtherProfileLikes() {
            latest = useFeedState({
                type: 'likes',
                userId: OTHER_ID,
                useScoped: false,
                isAuthenticated: true,
                currentUserId: VIEWER_ID,
            });
            return null;
        }

        let firstVisit!: TestRenderer.ReactTestRenderer;
        await act(async () => {
            firstVisit = TestRenderer.create(<OtherProfileLikes />);
        });
        await flush();
        expect(getUserFeedMock).toHaveBeenCalledTimes(1);
        act(() => firstVisit.unmount());

        // Whatever the viewer likes, it cannot change what SOMEONE ELSE liked.
        invalidateEngagementLists('like');

        let secondVisit!: TestRenderer.ReactTestRenderer;
        await act(async () => {
            secondVisit = TestRenderer.create(<OtherProfileLikes />);
        });
        await flush();
        expect(getUserFeedMock).toHaveBeenCalledTimes(1);
        act(() => secondVisit.unmount());
    });

    it('does not revalidate a boosts tab because a LIKE landed', async () => {
        serverLists.boosts = ['post-old'];

        const firstVisit = await openTab('boosts');
        expect(getUserFeedMock).toHaveBeenCalledTimes(1);
        act(() => firstVisit.unmount());

        invalidateEngagementLists('like');

        const secondVisit = await openTab('boosts');
        expect(getUserFeedMock).toHaveBeenCalledTimes(1);
        act(() => secondVisit.unmount());
    });
});
