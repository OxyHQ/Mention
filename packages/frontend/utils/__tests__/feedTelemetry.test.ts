/**
 * Tests for feed interaction telemetry — the impression/dwell tracker and the
 * descriptor resolver that feed the ranking algorithm.
 *
 * The load-bearing guarantees verified here:
 *   1. An impression fires AT MOST ONCE per post per feed session (no double
 *      counting on re-scroll / repeated visibility).
 *   2. The reported `durationMs` is the FULL accumulated visible dwell, summed
 *      across visible→hidden cycles, never double-counted.
 *   3. A post visible for < 1s never reports (flicker is filtered out).
 *   4. `resolveFeedDescriptor` maps the feed's type/userId/filters to the same
 *      descriptor the feed is fetched with.
 *
 * The tracker's only outward effect is `feedService.mockSendFeedInteraction`, which
 * is mocked so the test never touches the network/SDK layer. `@/lib/logger` is
 * mocked for the same reason.
 */

Object.assign(globalThis, { __DEV__: false });

jest.mock('@/services/feedService', () => ({
    feedService: { sendFeedInteraction: jest.fn().mockResolvedValue(undefined) },
}));

jest.mock('@/lib/logger', () => ({
    createScopedLogger: () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

import { feedService } from '@/services/feedService';
import { FeedImpressionTracker, resolveFeedDescriptor } from '../feedTelemetry';

const mockSendFeedInteraction = feedService.sendFeedInteraction as jest.Mock;

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
        mockSendFeedInteraction.mockClear();
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    it('does not report a post visible for less than 1s', () => {
        const t = new FeedImpressionTracker('for_you');
        t.setVisible('p1');
        jest.setSystemTime(500);
        t.setHidden('p1'); // only 500ms visible — below the 1s gate
        expect(mockSendFeedInteraction).not.toHaveBeenCalled();
        t.dispose();
        expect(mockSendFeedInteraction).not.toHaveBeenCalled();
    });

    it('reports exactly one impression with the full dwell on scroll-away', () => {
        const t = new FeedImpressionTracker('for_you');
        t.setVisible('p1');
        jest.setSystemTime(2500);
        t.setHidden('p1'); // 2500ms visible
        expect(mockSendFeedInteraction).toHaveBeenCalledTimes(1);
        expect(mockSendFeedInteraction).toHaveBeenCalledWith({
            feedDescriptor: 'for_you',
            postUri: 'p1',
            event: 'impression',
            durationMs: 2500,
        });
        t.dispose();
    });

    it('accumulates dwell across visible→hidden→visible cycles without double counting', () => {
        const t = new FeedImpressionTracker('for_you');
        // First visible span: 600ms (not yet qualified on its own).
        t.setVisible('p1');
        jest.setSystemTime(600);
        t.setHidden('p1');
        expect(mockSendFeedInteraction).not.toHaveBeenCalled();

        // Second visible span: 600ms more → 1200ms total → qualifies, reports once.
        jest.setSystemTime(1000);
        t.setVisible('p1');
        jest.setSystemTime(1600);
        t.setHidden('p1');

        expect(mockSendFeedInteraction).toHaveBeenCalledTimes(1);
        expect(mockSendFeedInteraction).toHaveBeenCalledWith(
            expect.objectContaining({ postUri: 'p1', event: 'impression', durationMs: 1200 }),
        );
        t.dispose();
    });

    it('never re-reports a post that becomes visible again after being sent', () => {
        const t = new FeedImpressionTracker('for_you');
        t.setVisible('p1');
        jest.setSystemTime(1500);
        t.setHidden('p1'); // reports once
        expect(mockSendFeedInteraction).toHaveBeenCalledTimes(1);

        // Re-enter the viewport later in the same session — must NOT re-report.
        jest.setSystemTime(5000);
        t.setVisible('p1');
        jest.setSystemTime(9000);
        t.setHidden('p1');
        expect(mockSendFeedInteraction).toHaveBeenCalledTimes(1);
        t.dispose();
        expect(mockSendFeedInteraction).toHaveBeenCalledTimes(1);
    });

    it('reports a still-visible qualified post on dispose (navigate away)', () => {
        const t = new FeedImpressionTracker('for_you');
        t.setVisible('p1');
        jest.setSystemTime(1800);
        t.dispose(); // never scrolled away — final flush reports it
        expect(mockSendFeedInteraction).toHaveBeenCalledTimes(1);
        expect(mockSendFeedInteraction).toHaveBeenCalledWith(
            expect.objectContaining({ postUri: 'p1', durationMs: 1800 }),
        );
    });

    it('reports a parked post via the safety-net timer (never scrolled, never disposed)', () => {
        const t = new FeedImpressionTracker('for_you');
        t.setVisible('p1');
        // Advance past the safety flush interval while the post stays visible.
        jest.setSystemTime(6000);
        jest.advanceTimersByTime(6000);
        expect(mockSendFeedInteraction).toHaveBeenCalledTimes(1);
        expect(mockSendFeedInteraction).toHaveBeenCalledWith(
            expect.objectContaining({ postUri: 'p1', event: 'impression' }),
        );
        t.dispose();
        // Dispose must not double-send the already-sent post.
        expect(mockSendFeedInteraction).toHaveBeenCalledTimes(1);
    });

    it('stops the safety timer after a bounded number of flushes when nothing qualifies', () => {
        const setIntervalSpy = jest.spyOn(globalThis, 'setInterval');
        const clearIntervalSpy = jest.spyOn(globalThis, 'clearInterval');
        const t = new FeedImpressionTracker('for_you');

        // Track a post then immediately hide it (visible 0ms → never qualifies,
        // never sent). It stays unsent forever, which used to keep the timer
        // running indefinitely. The bounded budget must now stop it.
        t.setVisible('p1');
        t.setHidden('p1');
        expect(setIntervalSpy).toHaveBeenCalledTimes(1);

        // Advance well past MAX_SAFETY_FLUSHES * SAFETY_FLUSH_INTERVAL_MS. The
        // timer must stop itself even though p1 is permanently unsent.
        jest.advanceTimersByTime(5000 * 8);
        expect(clearIntervalSpy).toHaveBeenCalled();
        expect(mockSendFeedInteraction).not.toHaveBeenCalled();

        t.dispose();
        setIntervalSpy.mockRestore();
        clearIntervalSpy.mockRestore();
    });

    it('re-arms the safety timer on a new visibility change after the budget is spent', () => {
        const setIntervalSpy = jest.spyOn(globalThis, 'setInterval');
        const t = new FeedImpressionTracker('for_you');

        // p1 enters but is hidden immediately (unsent) → timer arms then spends
        // its budget and stops.
        t.setVisible('p1');
        t.setHidden('p1');
        expect(setIntervalSpy).toHaveBeenCalledTimes(1);
        jest.advanceTimersByTime(5000 * 8);
        const armsAfterFirstBudget = setIntervalSpy.mock.calls.length;

        // A genuinely new visibility change (p2 enters) must re-arm the timer and
        // ultimately report p2 once it qualifies.
        jest.setSystemTime(5000 * 8);
        t.setVisible('p2');
        expect(setIntervalSpy.mock.calls.length).toBe(armsAfterFirstBudget + 1);

        // Advance one full safety interval: the re-armed timer fires and reports
        // p2 (visible the whole interval → well past the 1s qualification gate).
        jest.advanceTimersByTime(5000);
        expect(mockSendFeedInteraction).toHaveBeenCalledTimes(1);
        expect(mockSendFeedInteraction).toHaveBeenCalledWith(
            expect.objectContaining({ postUri: 'p2', event: 'impression' }),
        );

        t.dispose();
        setIntervalSpy.mockRestore();
    });

    it('syncVisible reconciles the viewable set (native path)', () => {
        const t = new FeedImpressionTracker('for_you');
        // p1 and p2 enter view.
        t.syncVisible(['p1', 'p2']);
        jest.setSystemTime(1500);
        // p1 stays, p2 leaves, p3 enters.
        t.syncVisible(['p1', 'p3']);
        // p2 was visible 1500ms → qualifies and reports on its implicit hide.
        expect(mockSendFeedInteraction).toHaveBeenCalledTimes(1);
        expect(mockSendFeedInteraction).toHaveBeenCalledWith(
            expect.objectContaining({ postUri: 'p2', durationMs: 1500 }),
        );

        jest.setSystemTime(3500);
        t.dispose();
        // p1 (3500ms) and p3 (2000ms) both qualify on dispose → 2 more reports.
        const reported = mockSendFeedInteraction.mock.calls.map((c) => c[0].postUri).sort();
        expect(reported).toEqual(['p1', 'p2', 'p3']);
    });

    it('ignores empty postUris', () => {
        const t = new FeedImpressionTracker('for_you');
        t.setVisible('');
        jest.setSystemTime(2000);
        t.setHidden('');
        t.dispose();
        expect(mockSendFeedInteraction).not.toHaveBeenCalled();
    });
});
