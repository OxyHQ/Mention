/**
 * Tests for feed interaction telemetry — the impression/dwell tracker, the
 * batching queue, and the descriptor resolver that feed the ranking algorithm.
 *
 * The load-bearing guarantees verified here:
 *   1. An impression fires AT MOST ONCE per post per feed session (no double
 *      counting on re-scroll / repeated visibility).
 *   2. The reported `durationMs` is the FULL accumulated visible dwell, summed
 *      across visible→hidden cycles, never double-counted.
 *   3. A post visible for < 1s never reports (flicker is filtered out).
 *   4. Interactions are BATCHED: many posts qualifying together cost ONE
 *      request, not one per post. This is the guarantee whose absence produced
 *      15–20 requests/second and 429s from the per-IP feed rate limiter.
 *   5. Teardown flushes early, so navigating away never strands a batch.
 *   6. `resolveFeedDescriptor` maps the feed's type/userId/filters to the same
 *      descriptor the feed is fetched with.
 *   7. `useFeedImpressionTracker` starts a NEW session — after flushing the old
 *      one — whenever the descriptor or the reset key changes. The reel is what
 *      makes this load-bearing: it switches feed (`videos` ↔ `following`) and
 *      resolves its viewer without ever unmounting.
 *   8. The batch's RESPONSE is consumed, not discarded: the server's view totals
 *      reach the shared post cache. Dropping them is what left a watched video's
 *      count stale until the next feed fetch.
 *
 * The tracker's outward effects are `feedService.sendFeedInteractions` and the
 * post cache, both mocked so the test never touches the network/SDK/SQLite
 * layers. `@oxyhq/core/logger` is mocked for the same reason.
 */

import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';

import { feedService } from '@/services/feedService';
import { applyServerViewCounts } from '@/stores/postsStore';
import {
    FeedImpressionTracker,
    flushFeedInteractions,
    reportFeedInteraction,
    resolveFeedDescriptor,
    useFeedImpressionTracker,
} from '../feedTelemetry';

Object.assign(globalThis, { __DEV__: false });
// Resolves an EMPTY count map, which is the real transport's answer whenever the
// server counted nothing (the common case) or the write failed.
jest.mock('@/services/feedService', () => ({
    feedService: { sendFeedInteractions: jest.fn().mockResolvedValue({}) },
}));

// The post cache the returned counts are written into. Mocked at the store's own
// boundary: the real module reaches SQLite and the SDK, neither of which loads
// here — `stores/__tests__/postsStoreGranularReactivity` covers the other half of
// this seam, that `applyServerViewCounts` actually writes through the store.
jest.mock('@/stores/postsStore', () => ({
    applyServerViewCounts: jest.fn(),
}));

// The module's other transport (`reportTrendEvent` → `POST /trending/events`).
// Mocked for the same reason as the feed one: the real service reaches the SDK
// client, which does not load under jest.
jest.mock('@/services/trendingService', () => ({
    trendingService: { sendTrendEvent: jest.fn().mockResolvedValue(undefined) },
}));

jest.mock('@oxyhq/core/logger', () => ({
    ...jest.requireActual('@oxyhq/core/logger'),
    createLogger: () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

const mockSendFeedInteractions = feedService.sendFeedInteractions as jest.Mock;
const mockApplyServerViewCounts = applyServerViewCounts as jest.Mock;

/** Every interaction handed to the transport, flattened across batches. */
function sentInteractions(): { postUri: string; event: string; durationMs?: number }[] {
    return mockSendFeedInteractions.mock.calls.flatMap((call) => call[0]);
}

describe('resolveFeedDescriptor', () => {
    it('uses the FeedType directly for standard feeds', () => {
        expect(resolveFeedDescriptor('for_you')).toBe('for_you');
        expect(resolveFeedDescriptor('following')).toBe('following');
        expect(resolveFeedDescriptor('explore')).toBe('explore');
        expect(resolveFeedDescriptor('videos')).toBe('videos');
    });

    it('maps the saved feed regardless of type', () => {
        expect(resolveFeedDescriptor('for_you', undefined, undefined, true)).toBe('saved');
    });

    it('maps a profile feed to author|<userId>', () => {
        expect(resolveFeedDescriptor('posts', 'user-123')).toBe('author|user-123');
    });

    it('maps scoped hashtag / topic / custom filters', () => {
        expect(resolveFeedDescriptor('hashtag', undefined, { hashtag: 'expo' })).toBe('hashtag|expo');
        expect(resolveFeedDescriptor('topic', undefined, { topic: 'tech' })).toBe('topic|tech');
        expect(resolveFeedDescriptor('custom', undefined, { customFeedId: 'cf1' })).toBe('custom|cf1');
    });

    // A lane tab is fetched by `lane|<id>` (`feedService`'s own branch), so
    // attributing it to the author feed would file every impression on that tab
    // against the wrong feed — silently, with nothing failing. The lane branch
    // therefore has to WIN over `userId`, not merely exist.
    it('maps a lane tab to lane|<laneId>, ahead of the author feed', () => {
        expect(resolveFeedDescriptor('posts', undefined, { laneId: 'lane-1' })).toBe('lane|lane-1');
        expect(resolveFeedDescriptor('posts', 'user-123', { laneId: 'lane-1' })).toBe('lane|lane-1');
    });

    it('keeps the saved feed ahead of a lane filter', () => {
        expect(resolveFeedDescriptor('posts', undefined, { laneId: 'lane-1' }, true)).toBe('saved');
    });

    // Same trap as the lane tab above, and a worse one to hit: a channel's posts
    // belong to nobody's profile, so `author|<id>` would not merely be the wrong
    // feed — it would be a feed those posts are excluded from entirely.
    it('maps a channel page to channel|<channelId>, ahead of the author feed', () => {
        expect(resolveFeedDescriptor('mixed', undefined, { channelId: 'channel-1' })).toBe('channel|channel-1');
        expect(resolveFeedDescriptor('mixed', 'user-123', { channelId: 'channel-1' })).toBe('channel|channel-1');
    });
});

describe('FeedImpressionTracker', () => {
    beforeEach(() => {
        jest.useFakeTimers();
        jest.setSystemTime(0);
        mockSendFeedInteractions.mockClear();
    });

    afterEach(() => {
        // Drain the shared module-level queue so no interaction leaks between tests.
        flushFeedInteractions();
        jest.useRealTimers();
    });

    it('does not report a post visible for less than 1s', () => {
        const t = new FeedImpressionTracker('for_you');
        t.setVisible('p1');
        jest.setSystemTime(500);
        t.setHidden('p1'); // only 500ms visible — below the 1s gate
        t.dispose();
        expect(mockSendFeedInteractions).not.toHaveBeenCalled();
    });

    it('reports exactly one impression with the full dwell on scroll-away', () => {
        const t = new FeedImpressionTracker('for_you');
        t.setVisible('p1');
        jest.setSystemTime(2500);
        t.setHidden('p1'); // 2500ms visible

        // Queued, not yet sent — the flush window has not elapsed.
        expect(mockSendFeedInteractions).not.toHaveBeenCalled();
        jest.advanceTimersByTime(1000);

        expect(mockSendFeedInteractions).toHaveBeenCalledTimes(1);
        expect(mockSendFeedInteractions).toHaveBeenCalledWith([
            {
                feedDescriptor: 'for_you',
                postUri: 'p1',
                event: 'impression',
                durationMs: 2500,
            },
        ]);
        t.dispose();
    });

    it('accumulates dwell across visible→hidden→visible cycles without double counting', () => {
        const t = new FeedImpressionTracker('for_you');
        // First visible span: 600ms (not yet qualified on its own).
        t.setVisible('p1');
        jest.setSystemTime(600);
        t.setHidden('p1');
        jest.advanceTimersByTime(1000);
        expect(mockSendFeedInteractions).not.toHaveBeenCalled();

        // Second visible span: 600ms more → 1200ms total → qualifies, reports once.
        jest.setSystemTime(1000);
        t.setVisible('p1');
        jest.setSystemTime(1600);
        t.setHidden('p1');
        t.dispose();

        expect(sentInteractions()).toEqual([
            expect.objectContaining({ postUri: 'p1', event: 'impression', durationMs: 1200 }),
        ]);
    });

    it('never re-reports a post that becomes visible again after being sent', () => {
        const t = new FeedImpressionTracker('for_you');
        t.setVisible('p1');
        jest.setSystemTime(1500);
        t.setHidden('p1'); // reports once
        jest.advanceTimersByTime(1000);
        expect(sentInteractions()).toHaveLength(1);

        // Re-enter the viewport later in the same session — must NOT re-report.
        jest.setSystemTime(5000);
        t.setVisible('p1');
        jest.setSystemTime(9000);
        t.setHidden('p1');
        t.dispose();
        expect(sentInteractions()).toHaveLength(1);
    });

    it('reports a still-visible qualified post on dispose (navigate away)', () => {
        const t = new FeedImpressionTracker('for_you');
        t.setVisible('p1');
        jest.setSystemTime(1800);
        t.dispose(); // never scrolled away — final flush reports it immediately

        expect(mockSendFeedInteractions).toHaveBeenCalledTimes(1);
        expect(sentInteractions()).toEqual([
            expect.objectContaining({ postUri: 'p1', durationMs: 1800 }),
        ]);
    });

    it('reports a parked post via the safety-net timer (never scrolled, never disposed)', () => {
        const t = new FeedImpressionTracker('for_you');
        t.setVisible('p1');
        // Advance past the safety flush interval while the post stays visible.
        jest.setSystemTime(6000);
        jest.advanceTimersByTime(6000);
        expect(sentInteractions()).toEqual([
            expect.objectContaining({ postUri: 'p1', event: 'impression' }),
        ]);
        t.dispose();
        // Dispose must not double-send the already-sent post.
        expect(sentInteractions()).toHaveLength(1);
    });

    it('syncVisible reconciles the viewable set (native path)', () => {
        const t = new FeedImpressionTracker('for_you');
        // p1 and p2 enter view.
        t.syncVisible(['p1', 'p2']);
        jest.setSystemTime(1500);
        // p1 stays, p2 leaves, p3 enters.
        t.syncVisible(['p1', 'p3']);
        jest.advanceTimersByTime(1000);
        // p2 was visible 1500ms → qualifies and reports on its implicit hide.
        expect(sentInteractions()).toEqual([
            expect.objectContaining({ postUri: 'p2', durationMs: 1500 }),
        ]);

        jest.setSystemTime(3500);
        t.dispose();
        // p1 (3500ms) and p3 (2000ms) both qualify on dispose → 2 more reports.
        const reported = sentInteractions().map((interaction) => interaction.postUri).sort();
        expect(reported).toEqual(['p1', 'p2', 'p3']);
    });

    it('ignores empty postUris', () => {
        const t = new FeedImpressionTracker('for_you');
        t.setVisible('');
        jest.setSystemTime(2000);
        t.setHidden('');
        t.dispose();
        expect(mockSendFeedInteractions).not.toHaveBeenCalled();
    });

    it('coalesces a whole screenful into ONE request, not one per post', () => {
        const t = new FeedImpressionTracker('for_you');
        const uris = Array.from({ length: 12 }, (_, i) => `p${i}`);
        t.syncVisible(uris);
        jest.setSystemTime(1500);
        // Every row scrolls out at once — the burst that used to emit 12 requests.
        t.syncVisible([]);

        jest.advanceTimersByTime(1000);
        expect(mockSendFeedInteractions).toHaveBeenCalledTimes(1);
        expect(mockSendFeedInteractions.mock.calls[0][0]).toHaveLength(12);
        t.dispose();
    });

    it('coalesces across trackers, because the rate limit is per client', () => {
        const a = new FeedImpressionTracker('for_you');
        const b = new FeedImpressionTracker('author|u1');
        a.setVisible('p1');
        b.setVisible('p2');
        jest.setSystemTime(1500);
        a.setHidden('p1');
        b.setHidden('p2');

        jest.advanceTimersByTime(1000);
        expect(mockSendFeedInteractions).toHaveBeenCalledTimes(1);
        expect(mockSendFeedInteractions.mock.calls[0][0]).toEqual([
            expect.objectContaining({ feedDescriptor: 'for_you', postUri: 'p1' }),
            expect.objectContaining({ feedDescriptor: 'author|u1', postUri: 'p2' }),
        ]);
        a.dispose();
        b.dispose();
    });

    it('splits a backlog larger than the batch cap across requests', () => {
        const t = new FeedImpressionTracker('for_you');
        const uris = Array.from({ length: 60 }, (_, i) => `p${i}`);
        t.syncVisible(uris);
        jest.setSystemTime(1500);
        t.syncVisible([]);

        jest.advanceTimersByTime(1000);
        expect(mockSendFeedInteractions).toHaveBeenCalledTimes(1);
        expect(mockSendFeedInteractions.mock.calls[0][0]).toHaveLength(50);

        // The remainder rides the next window rather than one oversized body.
        jest.advanceTimersByTime(1000);
        expect(mockSendFeedInteractions).toHaveBeenCalledTimes(2);
        expect(mockSendFeedInteractions.mock.calls[1][0]).toHaveLength(10);
        t.dispose();
    });

    it('never reports for a viewer who cannot use the private API', () => {
        const t = new FeedImpressionTracker('for_you', () => false);
        t.setVisible('p1');
        jest.setSystemTime(2000);
        t.setHidden('p1');
        t.dispose();
        expect(mockSendFeedInteractions).not.toHaveBeenCalled();
    });
});

describe('useFeedImpressionTracker', () => {
    // The live tracker of the mounted probe — re-read after every render, since a
    // session change replaces the instance behind the (stable) ref.
    let mounted: { current: FeedImpressionTracker } | null = null;

    function Probe({ descriptor, resetKey }: { descriptor: string; resetKey?: string }) {
        mounted = useFeedImpressionTracker(descriptor, resetKey);
        return null;
    }

    function tracker(): FeedImpressionTracker {
        if (!mounted) throw new Error('no tracker probe mounted');
        return mounted.current;
    }

    function mount(descriptor: string, resetKey?: string): TestRenderer.ReactTestRenderer {
        let created: TestRenderer.ReactTestRenderer | undefined;
        act(() => {
            created = TestRenderer.create(createElement(Probe, { descriptor, resetKey }));
        });
        if (!created) throw new Error('renderer was not created');
        return created;
    }

    beforeEach(() => {
        jest.useFakeTimers();
        jest.setSystemTime(0);
        mockSendFeedInteractions.mockClear();
        mounted = null;
    });

    afterEach(() => {
        flushFeedInteractions();
        jest.useRealTimers();
    });

    it('flushes the outgoing session when the descriptor changes mid-mount', () => {
        const renderer = mount('videos');
        const outgoing = tracker();
        tracker().setVisible('p1');
        jest.setSystemTime(2000);

        // The reel's tab switch: same mount, different feed.
        act(() => {
            renderer.update(createElement(Probe, { descriptor: 'following' }));
        });

        // Sent on the spot, not on the next flush window: dispose has no later
        // window to ride, so a tab switch must not strand the dwell it accrued.
        expect(sentInteractions()).toEqual([
            expect.objectContaining({ feedDescriptor: 'videos', postUri: 'p1', durationMs: 2000 }),
        ]);

        // …and the tracker behind the ref is a NEW one, so the same post counts
        // once more against the feed that is now being watched.
        expect(tracker()).not.toBe(outgoing);
        tracker().setVisible('p1');
        jest.setSystemTime(3500);
        tracker().setHidden('p1');
        jest.advanceTimersByTime(1000);

        expect(sentInteractions()).toEqual([
            expect.objectContaining({ feedDescriptor: 'videos', postUri: 'p1', durationMs: 2000 }),
            expect.objectContaining({ feedDescriptor: 'following', postUri: 'p1', durationMs: 1500 }),
        ]);
    });

    it('starts a new session on a reset key change without stranding the previous one', () => {
        // The auth cold boot: the viewer resolves 2s into the first video, which
        // is a new session for the same feed.
        const renderer = mount('videos');
        const anonymous = tracker();
        tracker().setVisible('p1');
        jest.setSystemTime(2000);

        act(() => {
            renderer.update(createElement(Probe, { descriptor: 'videos', resetKey: 'viewer-1' }));
        });

        expect(sentInteractions()).toEqual([
            expect.objectContaining({ postUri: 'p1', durationMs: 2000 }),
        ]);

        expect(tracker()).not.toBe(anonymous);
        tracker().setVisible('p2');
        jest.setSystemTime(3200);
        tracker().setHidden('p2');
        jest.advanceTimersByTime(1000);

        expect(sentInteractions()).toEqual([
            expect.objectContaining({ postUri: 'p1', durationMs: 2000 }),
            expect.objectContaining({ postUri: 'p2', durationMs: 1200 }),
        ]);
    });

    it('keeps ONE tracker across a re-render that changes neither', () => {
        const renderer = mount('videos', 'viewer-1');
        const first = tracker();
        act(() => {
            renderer.update(createElement(Probe, { descriptor: 'videos', resetKey: 'viewer-1' }));
        });

        expect(tracker()).toBe(first);
    });
});

describe('reportFeedInteraction', () => {
    beforeEach(() => {
        jest.useFakeTimers();
        mockSendFeedInteractions.mockClear();
    });

    afterEach(() => {
        flushFeedInteractions();
        jest.useRealTimers();
    });

    it('queues through the same batch as impressions', () => {
        reportFeedInteraction('for_you', 'p1', 'click');
        reportFeedInteraction('for_you', 'p2', 'like');
        expect(mockSendFeedInteractions).not.toHaveBeenCalled();

        jest.advanceTimersByTime(1000);
        expect(mockSendFeedInteractions).toHaveBeenCalledTimes(1);
        expect(mockSendFeedInteractions.mock.calls[0][0]).toEqual([
            { feedDescriptor: 'for_you', postUri: 'p1', event: 'click' },
            { feedDescriptor: 'for_you', postUri: 'p2', event: 'like' },
        ]);
    });

    it('drops an interaction with no descriptor or no post', () => {
        reportFeedInteraction('', 'p1', 'click');
        reportFeedInteraction('for_you', '', 'click');
        jest.advanceTimersByTime(1000);
        expect(mockSendFeedInteractions).not.toHaveBeenCalled();
    });
});

/**
 * The half of the impression round trip that used to be thrown away.
 *
 * The client cannot decide whether a view counted — the dedupe window, the
 * self-view guard and the eligibility filter are all server-side — so the only
 * way a screen learns about the view it just caused is by reading the answer.
 * Discarding it left the count stale until the next feed fetch, which is the
 * user-visible bug (watch a video, go back, the number has not moved).
 */
describe('server view counts from the batch response', () => {
    beforeEach(() => {
        jest.useFakeTimers();
        // Anchor the clock, as the tracker suites above do: the dwell gate measures
        // against `Date.now()` at `setVisible`, so a later `setSystemTime` must move
        // the clock FORWARD from a known origin, not backward from the real one.
        jest.setSystemTime(0);
        mockSendFeedInteractions.mockClear();
        mockApplyServerViewCounts.mockClear();
        mockSendFeedInteractions.mockResolvedValue({});
    });

    afterEach(() => {
        flushFeedInteractions();
        jest.useRealTimers();
    });

    /** Let the transport promise settle; the queue drains on a microtask. */
    const settle = () => act(async () => { await Promise.resolve(); });

    it('writes the returned totals into the post cache', async () => {
        mockSendFeedInteractions.mockResolvedValue({ p1: 42, p2: 7 });

        reportFeedInteraction('videos', 'p1', 'click');
        jest.advanceTimersByTime(1000);
        await settle();

        expect(mockApplyServerViewCounts).toHaveBeenCalledTimes(1);
        expect(mockApplyServerViewCounts).toHaveBeenCalledWith({ p1: 42, p2: 7 });
    });

    it('applies the totals reported on a teardown flush, not only a timed one', async () => {
        // The reel's own path: the impression is emitted as the screen goes away,
        // so the response lands after the flush that navigation triggered.
        mockSendFeedInteractions.mockResolvedValue({ p1: 9 });

        const tracker = new FeedImpressionTracker('videos');
        tracker.setVisible('p1');
        jest.setSystemTime(3000);
        tracker.dispose();
        await settle();

        expect(mockApplyServerViewCounts).toHaveBeenCalledWith({ p1: 9 });
    });

    it('never writes anything when the transport fails', async () => {
        mockSendFeedInteractions.mockRejectedValue(new Error('offline'));

        reportFeedInteraction('videos', 'p1', 'click');
        jest.advanceTimersByTime(1000);
        await settle();

        expect(mockApplyServerViewCounts).not.toHaveBeenCalled();
    });

    it('swallows a throw from the cache write, so telemetry cannot break a render', async () => {
        mockSendFeedInteractions.mockResolvedValue({ p1: 42 });
        mockApplyServerViewCounts.mockImplementationOnce(() => {
            throw new Error('cache unavailable');
        });

        reportFeedInteraction('videos', 'p1', 'click');
        expect(() => jest.advanceTimersByTime(1000)).not.toThrow();
        await settle();

        expect(mockApplyServerViewCounts).toHaveBeenCalledTimes(1);
    });
});
