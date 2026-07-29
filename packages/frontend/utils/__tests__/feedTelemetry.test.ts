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
 *
 * The tracker's only outward effect is `feedService.sendFeedInteractions`, which
 * is mocked so the test never touches the network/SDK layer. `@/lib/logger` is
 * mocked for the same reason.
 */

import { feedService } from '@/services/feedService';
import {
    FeedImpressionTracker,
    flushFeedInteractions,
    reportFeedInteraction,
    resolveFeedDescriptor,
} from '../feedTelemetry';

Object.assign(globalThis, { __DEV__: false });
jest.mock('@/services/feedService', () => ({
    feedService: { sendFeedInteractions: jest.fn().mockResolvedValue(undefined) },
}));

// The module's other transport (`reportTrendEvent` → `POST /trending/events`).
// Mocked for the same reason as the feed one: the real service reaches the SDK
// client, which does not load under jest.
jest.mock('@/services/trendingService', () => ({
    trendingService: { sendTrendEvent: jest.fn().mockResolvedValue(undefined) },
}));

jest.mock('@/lib/logger', () => ({
    createScopedLogger: () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

const mockSendFeedInteractions = feedService.sendFeedInteractions as jest.Mock;

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
