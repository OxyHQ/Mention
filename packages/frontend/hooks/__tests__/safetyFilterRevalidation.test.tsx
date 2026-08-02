import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import type { HydratedPost, SlicedFeedResponse } from '@mention/shared-types';
import { feedService } from '@/services/feedService';
import { usePostsStore } from '@/stores/postsStore';
import { clearAllFeedMemoryCaches } from '@/stores/feedScrollStore';
import { resetEngagementInvalidation } from '@/stores/engagementInvalidation';
import {
    invalidateSafetyFilters,
    resetSafetyInvalidation,
} from '@/stores/safetyInvalidation';
import { useFeedState, type UseFeedStateReturn } from '../useFeedState';

/**
 * Muting a word must hide the posts already on screen that match it, and
 * unmuting must bring them back — without the viewer reloading the app. Same for
 * the sensitive-content toggle. A viewer who asks not to see something and keeps
 * seeing it is a safety failure, not a staleness annoyance.
 *
 * Both rules are applied ENTIRELY on the server, so this file models the server
 * honestly: `serverPosts` is everything that exists, and the fake transport
 * returns only what the CURRENT rules allow. That is what makes the un-mute
 * direction a real assertion — a post the rules excluded was never sent to this
 * device, so nothing but a refetch can put it back, and a client-side filter
 * would pass the hide test while silently failing this one.
 *
 * The write side of the signal is the two settings screens, which call
 * `invalidateSafetyFilters` after the server accepts the change; the read side is
 * `useFeedState`, in two halves — a live subscription for feeds still mounted
 * under the settings screen, and a warm-start staleness check for feeds that were
 * unmounted when the rule changed. Both halves are exercised here.
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

// Web has no SQLite and runs the memory path; native has it and reads through
// the store instead. Both branches carry the fix, so both are switched on here.
let mockDbAvailable = false;

jest.mock('@/db', () => ({
    buildFeedKey: jest.fn(() => FEED_KEY),
    hasFeedData: jest.fn(() => mockDbAvailable),
    isDbAvailable: jest.fn(() => mockDbAvailable),
}));

jest.mock('@oxyhq/core/logger', () => ({
    ...jest.requireActual('@oxyhq/core/logger'),
    createLogger: () => ({ debug: jest.fn(), error: jest.fn(), warn: jest.fn() }),
}));

jest.mock('@/lib/precacheActorsFromPosts', () => ({
    precacheActorsFromPosts: jest.fn(),
}));

const VIEWER_ID = 'viewer-a';
const FEED_KEY = 'feed-key';

/** One post as the server holds it, before any viewer rule is applied. */
interface ServerPost {
    id: string;
    text: string;
    sensitive?: boolean;
}

/** Everything that exists, and the viewer's rules as the server currently has them. */
let serverPosts: ServerPost[] = [];
let mutedWords: string[] = [];
let showSensitiveContent = false;

/**
 * The server's half of both rules: a muted post is dropped from the response and
 * a sensitive one never enters the query, so neither ever reaches the client.
 */
function visiblePosts(): ServerPost[] {
    return serverPosts.filter((post) => {
        if (post.sensitive && !showSensitiveContent) return false;
        return !mutedWords.some((word) => post.text.toLowerCase().includes(word));
    });
}

function page(posts: ServerPost[]): SlicedFeedResponse {
    return {
        items: posts.map(
            (post) => ({ id: post.id, user: { id: `author-${post.id}` } }) as unknown as HydratedPost,
        ),
        slices: [],
        interstitials: [],
        hasMore: false,
        totalCount: posts.length,
    };
}

let latest: UseFeedStateReturn | undefined;

/**
 * Every feed opened by this file and not yet closed. A mounted feed holds a live
 * subscription, so one leaked by a failing assertion would answer the NEXT test's
 * signal and report a second, unrelated failure there — which is exactly what a
 * mutation test must not do if its output is to name the code it broke.
 */
const openFeeds = new Set<TestRenderer.ReactTestRenderer>();

function HomeFeed() {
    latest = useFeedState({
        type: 'for_you',
        useScoped: false,
        isAuthenticated: true,
        currentUserId: VIEWER_ID,
    });
    return null;
}

const getFeedMock = feedService.getFeed as jest.Mock;

async function flush(): Promise<void> {
    await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
    });
}

/** Open the feed, as a navigation would: a fresh mount. */
async function openFeed(): Promise<TestRenderer.ReactTestRenderer> {
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
        renderer = TestRenderer.create(<HomeFeed />);
    });
    await flush();
    openFeeds.add(renderer);
    return renderer;
}

/** Navigate away from the feed: it unmounts and unsubscribes. */
function closeFeed(renderer: TestRenderer.ReactTestRenderer): void {
    act(() => renderer.unmount());
    openFeeds.delete(renderer);
}

/**
 * Change a safety rule the way the settings screens do: the server accepts the
 * write first, then the one authority tells the caches. Never unmounts anything.
 */
async function changeSafetyRule(change: () => void): Promise<void> {
    await act(async () => {
        change();
        invalidateSafetyFilters();
    });
    await flush();
}

function renderedIds(): string[] {
    return (latest?.items ?? []).map((item) => item.id);
}

describe('safety rules converge on the feeds the viewer is looking at', () => {
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
        resetSafetyInvalidation();
        serverPosts = [];
        mutedWords = [];
        showSensitiveContent = false;
        mockDbAvailable = false;
        usePostsStore.getState().feedUI = {};
        getFeedMock.mockImplementation(() => Promise.resolve(page(visiblePosts())));
    });

    afterEach(() => {
        for (const renderer of openFeeds) {
            act(() => renderer.unmount());
        }
        openFeeds.clear();
    });

    it('hides a matching post from the feed on screen when a word is muted, then brings it back when it is unmuted', async () => {
        serverPosts = [
            { id: 'post-cats', text: 'a thread about cats' },
            { id: 'post-dogs', text: 'a thread about dogs' },
        ];

        const feed = await openFeed();
        expect(renderedIds()).toEqual(['post-cats', 'post-dogs']);

        // The viewer mutes "dogs" from the settings screen pushed over this feed.
        // The feed is never unmounted for the rest of this test.
        await changeSafetyRule(() => {
            mutedWords = ['dogs'];
        });
        expect(renderedIds()).toEqual(['post-cats']);

        // Unmuting has to bring it back. This is the direction no client-side
        // filter could serve: the post was withheld, so it is not held anywhere
        // on this device to un-hide.
        await changeSafetyRule(() => {
            mutedWords = [];
        });
        expect(renderedIds()).toEqual(['post-cats', 'post-dogs']);

        closeFeed(feed);
    });

    it('reveals and re-hides sensitive posts as the viewer toggles show-sensitive-content', async () => {
        serverPosts = [
            { id: 'post-safe', text: 'a sunset' },
            { id: 'post-sensitive', text: 'not for everyone', sensitive: true },
        ];

        const feed = await openFeed();
        expect(renderedIds()).toEqual(['post-safe']);

        await changeSafetyRule(() => {
            showSensitiveContent = true;
        });
        expect(renderedIds()).toEqual(['post-safe', 'post-sensitive']);

        await changeSafetyRule(() => {
            showSensitiveContent = false;
        });
        expect(renderedIds()).toEqual(['post-safe']);

        closeFeed(feed);
    });

    it('applies a rule changed while the feed was unmounted on its next mount', async () => {
        serverPosts = [
            { id: 'post-cats', text: 'a thread about cats' },
            { id: 'post-dogs', text: 'a thread about dogs' },
        ];

        const firstVisit = await openFeed();
        expect(renderedIds()).toEqual(['post-cats', 'post-dogs']);
        closeFeed(firstVisit);

        // Nothing is subscribed now, so only the retained slice's age can carry
        // the change to the next mount.
        mutedWords = ['dogs'];
        invalidateSafetyFilters();

        const secondVisit = await openFeed();
        expect(renderedIds()).toEqual(['post-cats']);
        closeFeed(secondVisit);
    });

    it('still warm-starts without a request when no safety rule changed', async () => {
        serverPosts = [{ id: 'post-cats', text: 'a thread about cats' }];

        const firstVisit = await openFeed();
        expect(getFeedMock).toHaveBeenCalledTimes(1);
        closeFeed(firstVisit);

        // Reopening a feed under unchanged rules must stay free. This is the
        // property a blanket "always refetch on mount" would destroy, and the
        // reason the warm start exists at all.
        const secondVisit = await openFeed();
        expect(getFeedMock).toHaveBeenCalledTimes(1);
        expect(renderedIds()).toEqual(['post-cats']);
        closeFeed(secondVisit);
    });

    it('leaves an unmounted feed alone until it is opened again', async () => {
        serverPosts = [{ id: 'post-cats', text: 'a thread about cats' }];

        const firstVisit = await openFeed();
        expect(getFeedMock).toHaveBeenCalledTimes(1);
        closeFeed(firstVisit);

        // An unsubscribed feed must not be woken by the signal — the whole point
        // of the staleness half is that it costs nothing until the feed is needed.
        act(() => {
            invalidateSafetyFilters();
        });
        expect(getFeedMock).toHaveBeenCalledTimes(1);
    });

    /**
     * Native reads its feed out of SQLite rather than local state, so the same
     * question is asked in a different place: `fetchInitial` skips the fetch
     * entirely when the store says this feed was already loaded. That skip has to
     * notice a safety rule changed since, or the rows SQLite is holding — which
     * survive an app restart — keep being served.
     */
    describe('on the SQLite path', () => {
        /** Put the store in the state a previously-loaded native feed leaves behind. */
        function seedLoadedSqliteFeed(): void {
            mockDbAvailable = true;
            usePostsStore.getState().feedUI = {
                [FEED_KEY]: { isLoading: false, error: null, lastUpdated: Date.now() },
            };
        }

        it('refetches on the next mount when a rule changed since the cache was written', async () => {
            seedLoadedSqliteFeed();
            const fetchFeed = usePostsStore.getState().fetchFeed as jest.Mock;

            const firstVisit = await openFeed();
            expect(fetchFeed).not.toHaveBeenCalled();
            closeFeed(firstVisit);

            invalidateSafetyFilters();

            const secondVisit = await openFeed();
            expect(fetchFeed).toHaveBeenCalledTimes(1);
            closeFeed(secondVisit);
        });

        it('still serves the SQLite cache without a request when no rule changed', async () => {
            seedLoadedSqliteFeed();
            const fetchFeed = usePostsStore.getState().fetchFeed as jest.Mock;

            const firstVisit = await openFeed();
            closeFeed(firstVisit);

            const secondVisit = await openFeed();
            expect(fetchFeed).not.toHaveBeenCalled();
            closeFeed(secondVisit);
        });
    });
});
