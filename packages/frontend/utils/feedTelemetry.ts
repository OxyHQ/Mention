import { useEffect, useRef } from 'react';
import { FeedType } from '@mention/shared-types';
import { feedService } from '@/services/feedService';
import { createScopedLogger } from '@/lib/logger';
import { FeedFilters } from './feedUtils';

/**
 * Feed interaction telemetry.
 *
 * The ranking algorithm is fed by per-post impression/dwell/click signals.
 * This module owns BOTH halves of the contract so the web (window virtualizer)
 * and native (FlashList) feeds report identically:
 *
 *  - `resolveFeedDescriptor` turns the Feed component's `type`/`userId`/`filters`
 *    into the same descriptor string the feed was actually fetched with, so an
 *    interaction is attributed to the correct feed source.
 *  - `FeedImpressionTracker` dedupes impressions (once per post per feed
 *    session), accumulates visible dwell time, and batches network writes so a
 *    fast scroll never spams `POST /feed/mtn/interactions`.
 *
 * All writes are best-effort: `feedService.sendFeedInteraction` swallows and
 * debug-logs its own failures, so telemetry can never block or break the feed.
 */

const logger = createScopedLogger('FeedTelemetry');

export type FeedInteractionEvent = 'impression' | 'click' | 'like' | 'reply' | 'boost' | 'save';

/**
 * Derive the feed descriptor a Feed instance reports against. Mirrors how
 * `feedService` routes the fetch:
 *  - saved feed → 'saved'
 *  - a profile feed (userId present) → 'author|<userId>'
 *  - hashtag/topic/custom scoped filters → their descriptor form
 *  - everything else → the FeedType used directly (for_you/following/explore/…)
 */
export function resolveFeedDescriptor(
    type: FeedType,
    userId?: string,
    filters?: FeedFilters,
    showOnlySaved?: boolean,
): string {
    if (showOnlySaved) return 'saved';
    if (userId) return `author|${userId}`;
    if (filters?.hashtag) return `hashtag|${filters.hashtag}`;
    if (filters?.topic) return `topic|${filters.topic}`;
    if (filters?.customFeedId) return `custom|${filters.customFeedId}`;
    return type;
}

// A post must be ≥50% visible for at least this long before it counts as seen.
const MIN_VISIBLE_MS = 1000;

// Safety-net cadence: a qualified post that the user parks on (never scrolls
// away, feed never unmounts) is reported on this interval so its impression is
// never lost. The COMMON path (scroll-away / unmount) reports immediately with
// the full dwell; this only covers the parked-indefinitely case.
const SAFETY_FLUSH_INTERVAL_MS = 5000;

// Bounded lifetime for the safety timer: after this many flushes with no new
// visibility change, the timer stops itself (with a final flush) so an idle feed
// the user parks on never holds a live interval indefinitely. Any real scroll /
// visibility change re-arms it (and resets the budget) via `setVisible`, so a
// later-qualifying post is still covered. With SAFETY_FLUSH_INTERVAL_MS=5s this
// caps a fully idle parked feed at ~30s of timer activity.
const MAX_SAFETY_FLUSHES = 6;

interface PendingImpression {
    postUri: string;
    // Total accumulated visible time, summed across visible→hidden cycles.
    durationMs: number;
    // Wall-clock ms at which the post became (and is still) visible, or null
    // when it is currently hidden. Used to accrue the in-progress visible span.
    visibleSince: number | null;
    // Whether the post has crossed MIN_VISIBLE_MS and is eligible to report.
    qualified: boolean;
    // Whether the (single) impression has already been sent for this session.
    sent: boolean;
}

/**
 * Per-feed-instance impression + dwell tracker.
 *
 * Lifecycle: construct once per mounted feed, call `setVisible`/`setHidden` (web)
 * or `syncVisible` (native) as rows enter/leave the viewport, and `dispose` on
 * unmount. Reset (via a fresh instance, see `useFeedImpressionTracker`) when the
 * descriptor changes or the feed refreshes so a new feed session re-counts.
 *
 * Reporting model: an impression is sent EXACTLY ONCE per post per session, with
 * the FULL accumulated visible dwell. It is emitted on scroll-away (`setHidden`)
 * or feed teardown (`dispose`) — whichever comes first after the post has been
 * visible ≥1s — so no post is double-counted and the dwell value is complete.
 */
export class FeedImpressionTracker {
    private readonly descriptor: string;
    private readonly pending = new Map<string, PendingImpression>();
    private safetyTimer: ReturnType<typeof setInterval> | null = null;
    // Flushes elapsed since the timer was last (re)armed. Reset on every re-arm
    // so a real scroll/visibility change always grants a fresh safety budget.
    private safetyFlushesSinceArm = 0;
    private disposed = false;

    constructor(descriptor: string) {
        this.descriptor = descriptor;
    }

    /** Mark a post as ≥50% visible (idempotent while it stays visible). */
    setVisible(postUri: string): void {
        if (this.disposed || !postUri) return;
        const entry = this.pending.get(postUri);
        const now = Date.now();
        if (!entry) {
            this.pending.set(postUri, {
                postUri,
                durationMs: 0,
                visibleSince: now,
                qualified: false,
                sent: false,
            });
            this.ensureSafetyTimer();
            return;
        }
        // Already tracked; only (re)start the visible span if it was hidden.
        if (entry.visibleSince === null && !entry.sent) {
            entry.visibleSince = now;
            this.ensureSafetyTimer();
        }
    }

    /**
     * Mark a post as no longer ≥50% visible: accrue its visible span and, if it
     * qualifies, report the FULL accumulated dwell once.
     */
    setHidden(postUri: string): void {
        if (this.disposed || !postUri) return;
        const entry = this.pending.get(postUri);
        if (!entry || entry.visibleSince === null) return;
        this.accrue(entry, Date.now());
        this.report(entry);
    }

    /**
     * Reconcile the full set of currently-visible posts in one call (native:
     * `onViewableItemsChanged` gives the whole viewable set each change).
     * Posts newly visible are marked visible; previously-visible posts no longer
     * in the set are marked hidden.
     */
    syncVisible(visibleUris: string[]): void {
        if (this.disposed) return;
        const visibleSet = new Set(visibleUris);
        // Hide entries that dropped out of the viewable set.
        for (const entry of this.pending.values()) {
            if (entry.visibleSince !== null && !visibleSet.has(entry.postUri)) {
                this.setHidden(entry.postUri);
            }
        }
        // Show entries newly in the viewable set.
        for (const uri of visibleSet) {
            this.setVisible(uri);
        }
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.stopSafetyTimer();
        // Final report: accrue any still-visible spans and emit what qualifies.
        const now = Date.now();
        for (const entry of this.pending.values()) {
            if (entry.visibleSince !== null) this.accrue(entry, now);
            this.report(entry);
        }
        this.pending.clear();
    }

    // (Re)arm the bounded safety timer. Called on every real visibility change so
    // a fresh scroll always grants a new flush budget: if a timer is already
    // running we just reset the budget, otherwise we start one. The timer stops
    // itself once the budget is spent (see `safetyFlush`); the next visibility
    // change starts it again.
    private ensureSafetyTimer(): void {
        if (this.disposed) return;
        this.safetyFlushesSinceArm = 0;
        if (this.safetyTimer) return;
        this.safetyTimer = setInterval(() => this.safetyFlush(), SAFETY_FLUSH_INTERVAL_MS);
    }

    private stopSafetyTimer(): void {
        if (this.safetyTimer) {
            clearInterval(this.safetyTimer);
            this.safetyTimer = null;
        }
    }

    // Fold the in-progress visible span (visibleSince → `now`) into the total,
    // end the span, and re-evaluate the MIN_VISIBLE_MS qualification gate.
    private accrue(entry: PendingImpression, now: number): void {
        if (entry.visibleSince !== null) {
            entry.durationMs += Math.max(0, now - entry.visibleSince);
            entry.visibleSince = null;
        }
        if (entry.durationMs >= MIN_VISIBLE_MS) entry.qualified = true;
    }

    // Safety net for posts the user parks on without ever scrolling away: snapshot
    // their running dwell and report once they qualify. Keeps the span open so a
    // later scroll-away is a no-op (already sent).
    //
    // The timer has a BOUNDED lifetime: it stops once every tracked post has been
    // reported, OR after MAX_SAFETY_FLUSHES with no new visibility change — so an
    // idle feed the user parks on never runs the interval forever. Both stop paths
    // run a flush first, so no qualified impression is lost. A subsequent scroll /
    // visibility change re-arms the timer (and resets the budget) via setVisible.
    private safetyFlush(): void {
        if (this.disposed) return;
        this.safetyFlushesSinceArm += 1;
        const now = Date.now();
        let anyUnsent = false;
        for (const entry of this.pending.values()) {
            if (entry.sent) continue;
            anyUnsent = true;
            if (entry.visibleSince !== null) {
                entry.durationMs += Math.max(0, now - entry.visibleSince);
                entry.visibleSince = now; // keep visible; re-anchor for next tick
                if (entry.durationMs >= MIN_VISIBLE_MS) entry.qualified = true;
                this.report(entry);
            }
        }
        // Everything reported, or the bounded budget is spent: stop until the next
        // real visibility change re-arms us. The flush above already emitted any
        // qualified impressions, so stopping here loses nothing.
        if (!anyUnsent || this.safetyFlushesSinceArm >= MAX_SAFETY_FLUSHES) {
            this.stopSafetyTimer();
        }
    }

    // Emit the impression exactly once per post (with the accumulated dwell).
    private report(entry: PendingImpression): void {
        if (!entry.qualified || entry.sent) return;
        entry.sent = true;
        feedService.sendFeedInteraction({
            feedDescriptor: this.descriptor,
            postUri: entry.postUri,
            event: 'impression',
            durationMs: entry.durationMs,
        }).catch((error) => {
            // sendFeedInteraction already swallows + debug-logs network failures;
            // this guards against any synchronous throw so telemetry can't bubble.
            logger.debug('Impression report failed', { error });
        });
    }
}

/**
 * Own a {@link FeedImpressionTracker} for the lifetime of a feed session.
 *
 * A FRESH tracker is created whenever the impression session must reset — the
 * descriptor changes (different feed source) or `resetKey` changes (a refresh /
 * reload). The previous tracker is disposed first so its still-visible posts get
 * a final flush. Returns the live tracker through a ref-stable getter so render
 * code can read it without re-subscribing.
 */
export function useFeedImpressionTracker(
    descriptor: string,
    resetKey?: string | number,
): { current: FeedImpressionTracker } {
    const trackerRef = useRef<FeedImpressionTracker | null>(null);
    // The session identity the current tracker was built for. A change in either
    // the descriptor or the reset key starts a new session.
    const sessionKeyRef = useRef<string>(`${descriptor}::${resetKey ?? ''}`);

    // Lazily create on first render so the very first viewable rows are tracked
    // even before any effect runs.
    if (trackerRef.current === null) {
        trackerRef.current = new FeedImpressionTracker(descriptor);
    }

    // Recreate the tracker when the session identity changes (different feed
    // source or a refresh/reload). Disposing the old one flushes its outstanding
    // impressions before the new session begins. Done during render — guarded by
    // the session-key ref so it runs at most once per real change — so the new
    // tracker is live for this render's viewability callbacks (no missed first
    // page after a refresh).
    const sessionKey = `${descriptor}::${resetKey ?? ''}`;
    if (sessionKeyRef.current !== sessionKey) {
        sessionKeyRef.current = sessionKey;
        trackerRef.current.dispose();
        trackerRef.current = new FeedImpressionTracker(descriptor);
    }

    // Dispose on unmount so a navigated-away feed flushes and stops its timer.
    useEffect(() => () => {
        trackerRef.current?.dispose();
        trackerRef.current = null;
    }, []);

    return trackerRef as { current: FeedImpressionTracker };
}

/**
 * Emit a single, non-impression feed interaction (click/like/reply/boost/save).
 * Best-effort and self-logging; safe to call from a press handler.
 */
export function reportFeedInteraction(
    feedDescriptor: string,
    postUri: string,
    event: Exclude<FeedInteractionEvent, 'impression'>,
): void {
    if (!feedDescriptor || !postUri) return;
    feedService.sendFeedInteraction({ feedDescriptor, postUri, event }).catch((error) => {
        logger.debug('Interaction report failed', { event, error });
    });
}
