import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import type { HydratedPost, SlicedFeedResponse } from '@mention/shared-types';
import { feedService } from '@/services/feedService';
import { usePostsStore } from '@/stores/postsStore';
import { clearAllFeedMemoryCaches } from '@/stores/feedScrollStore';
import { resetEngagementInvalidation } from '@/stores/engagementInvalidation';
import { resetSafetyInvalidation } from '@/stores/safetyInvalidation';
import {
    noteChannelBylineChanged,
    resetBylineInvalidation,
} from '@/stores/bylineInvalidation';
import { useFeedState, type UseFeedStateReturn } from '../useFeedState';

/**
 * Turning "Name the writer" on must make the channel's posts name their writer,
 * and turning it off must take the name back off them — on the feed the operator
 * is looking at, without a reload.
 *
 * The disclosure is decided ENTIRELY on the server, so this file models the server
 * honestly: `serverPosts` records who actually wrote each post, and the fake
 * transport puts the writer in `authors` only while the channel discloses. That is
 * what makes the OFF → ON direction a real assertion — while the byline is off the
 * writer's id is never sent to this device at all, so nothing held here could
 * reconstruct the byline and only a refetch can produce it. A local transform
 * would pass the ON → OFF case (the writer is in the cached DTO to strip) and fail
 * this one, which is precisely the wrong fix this exists to rule out.
 *
 * The write side is `channelAccountService.setSignPosts`, which calls
 * `noteChannelBylineChanged` after the server accepts — pinned separately in
 * `services/__tests__/channelAccountService.test.ts`, since a screen that stops
 * reporting is invisible from here. The read side is `useFeedState`, in two
 * halves: a live subscription for the channel page still mounted under the
 * settings screen, and a warm-start staleness check for feeds that were unmounted
 * when the toggle was flipped. Both halves are exercised here, on both paths
 * (memory-mode web and SQLite native).
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

// Web has no SQLite and runs the memory path; native has it and reads through the
// store instead. Both branches carry the fix, so both are switched on here.
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

const VIEWER_ID = 'operator-a';
const CHANNEL_ID = 'channel-1';
const WRITER_ID = 'writer-1';
const FEED_KEY = 'feed-key';

/** One post as the server holds it, including who wrote it for the channel. */
interface ServerPost {
    id: string;
    authorId: string;
    /** The human behind a channel post. Never sent while the channel is anonymous. */
    writerId?: string;
}

let serverPosts: ServerPost[] = [];

/** Whether the channel currently names the people who write for it. */
let channelDiscloses = false;

/**
 * The server's half of the rule: `PostHydrationService` appends the writer to
 * `authors` as `role: 'writer'` when the channel discloses, and omits them
 * entirely when it does not — so with the byline off, the writer's id never
 * crosses the wire.
 */
function page(): SlicedFeedResponse {
    return {
        items: serverPosts.map((post) => {
            const authors = [{ id: post.authorId, role: 'owner' }];
            if (post.writerId && channelDiscloses) {
                authors.push({ id: post.writerId, role: 'writer' });
            }
            return {
                id: post.id,
                user: { id: post.authorId },
                authors,
            } as unknown as HydratedPost;
        }),
        slices: [],
        interstitials: [],
        hasMore: false,
        totalCount: serverPosts.length,
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

/** The channel's own page: the author feed the operator returns to on Back. */
function ChannelFeed() {
    latest = useFeedState({
        type: 'posts',
        userId: CHANNEL_ID,
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

/** Open the feed, as a navigation would: a fresh mount. */
async function openFeed(): Promise<TestRenderer.ReactTestRenderer> {
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
        renderer = TestRenderer.create(<ChannelFeed />);
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
 * Flip the toggle the way the settings screen does: the server accepts the write
 * first, then the one authority tells the caches. Never unmounts anything — the
 * settings screen is pushed OVER the channel page, which stays mounted underneath.
 */
async function setSignPosts(discloses: boolean): Promise<void> {
    await act(async () => {
        channelDiscloses = discloses;
        noteChannelBylineChanged(CHANNEL_ID);
    });
    await flush();
}

/** Who the rendered rows currently name, post by post. */
function renderedBylines(): string[][] {
    return (latest?.items ?? []).map((item) => (item.authors ?? []).map((author) => author.id));
}

describe('a channel byline converges on the feeds the operator is looking at', () => {
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
        resetBylineInvalidation();
        serverPosts = [
            { id: 'post-1', authorId: CHANNEL_ID, writerId: WRITER_ID },
            { id: 'post-2', authorId: CHANNEL_ID, writerId: WRITER_ID },
        ];
        channelDiscloses = false;
        mockDbAvailable = false;
        usePostsStore.getState().feedUI = {};
        getUserFeedMock.mockImplementation(() => Promise.resolve(page()));
    });

    afterEach(() => {
        for (const renderer of openFeeds) {
            act(() => renderer.unmount());
        }
        openFeeds.clear();
    });

    it('names the writer on the page already open when the operator turns the byline on', async () => {
        const feed = await openFeed();
        expect(renderedBylines()).toEqual([[CHANNEL_ID], [CHANNEL_ID]]);

        // The direction no client-side transform could serve: while the byline was
        // off the writer's id was never sent here, so it is not held anywhere on
        // this device to reveal.
        await setSignPosts(true);
        expect(renderedBylines()).toEqual([
            [CHANNEL_ID, WRITER_ID],
            [CHANNEL_ID, WRITER_ID],
        ]);

        closeFeed(feed);
    });

    it('takes the writer back off the page already open when the operator turns the byline off', async () => {
        channelDiscloses = true;

        const feed = await openFeed();
        expect(renderedBylines()).toEqual([
            [CHANNEL_ID, WRITER_ID],
            [CHANNEL_ID, WRITER_ID],
        ]);

        // The other direction, and the one where being late has a person's name in
        // it: a row that keeps naming a writer whose channel has stopped disclosing.
        await setSignPosts(false);
        expect(renderedBylines()).toEqual([[CHANNEL_ID], [CHANNEL_ID]]);

        closeFeed(feed);
    });

    it('applies a byline changed while the feed was unmounted on its next mount', async () => {
        const firstVisit = await openFeed();
        expect(renderedBylines()).toEqual([[CHANNEL_ID], [CHANNEL_ID]]);
        closeFeed(firstVisit);

        // Nothing is subscribed now, so only the retained slice's age can carry the
        // change to the next mount.
        channelDiscloses = true;
        noteChannelBylineChanged(CHANNEL_ID);

        const secondVisit = await openFeed();
        expect(renderedBylines()).toEqual([
            [CHANNEL_ID, WRITER_ID],
            [CHANNEL_ID, WRITER_ID],
        ]);
        closeFeed(secondVisit);
    });

    it('still warm-starts without a request when no byline changed', async () => {
        const firstVisit = await openFeed();
        expect(getUserFeedMock).toHaveBeenCalledTimes(1);
        closeFeed(firstVisit);

        // The control. Without it, "refetches when the byline changes" and "always
        // refetches" are the same test — and the second would destroy the warm
        // start that keeps a deep-scrolled feed from resetting on every Back.
        const secondVisit = await openFeed();
        expect(getUserFeedMock).toHaveBeenCalledTimes(1);
        expect(renderedBylines()).toEqual([[CHANNEL_ID], [CHANNEL_ID]]);
        closeFeed(secondVisit);
    });

    it('leaves an unmounted feed alone until it is opened again', async () => {
        const firstVisit = await openFeed();
        expect(getUserFeedMock).toHaveBeenCalledTimes(1);
        closeFeed(firstVisit);

        // An unsubscribed feed must not be woken — the whole point of the staleness
        // half is that it costs nothing until the feed is needed.
        act(() => {
            noteChannelBylineChanged(CHANNEL_ID);
        });
        expect(getUserFeedMock).toHaveBeenCalledTimes(1);
    });

    /**
     * Native reads its feed out of SQLite rather than local state, so the same
     * question is asked in a different place: `fetchInitial` skips the fetch
     * entirely when the store says this feed was already loaded. That skip has to
     * notice a byline changed since, or the rows SQLite is holding — which survive
     * an app restart — keep naming (or not naming) the writer forever.
     */
    describe('on the SQLite path', () => {
        /** Put the store in the state a previously-loaded native feed leaves behind. */
        function seedLoadedSqliteFeed(): void {
            mockDbAvailable = true;
            usePostsStore.getState().feedUI = {
                [FEED_KEY]: { isLoading: false, error: null, lastUpdated: Date.now() },
            };
        }

        it('refetches on the next mount when the byline changed since the cache was written', async () => {
            seedLoadedSqliteFeed();
            const fetchUserFeed = usePostsStore.getState().fetchUserFeed as jest.Mock;

            const firstVisit = await openFeed();
            expect(fetchUserFeed).not.toHaveBeenCalled();
            closeFeed(firstVisit);

            noteChannelBylineChanged(CHANNEL_ID);

            const secondVisit = await openFeed();
            expect(fetchUserFeed).toHaveBeenCalledTimes(1);
            closeFeed(secondVisit);
        });

        it('still serves the SQLite cache without a request when no byline changed', async () => {
            seedLoadedSqliteFeed();
            const fetchUserFeed = usePostsStore.getState().fetchUserFeed as jest.Mock;

            const firstVisit = await openFeed();
            closeFeed(firstVisit);

            const secondVisit = await openFeed();
            expect(fetchUserFeed).not.toHaveBeenCalled();
            closeFeed(secondVisit);
        });
    });
});
