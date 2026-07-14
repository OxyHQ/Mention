/**
 * Unit tests for the shared feed-row model: `buildFeedRows` splicing the server's
 * recommendation-card placements between post slices, and the row key / recycle
 * bucket helpers for both branches of the `FeedRow` union.
 *
 * Only the PURE row-building functions are exercised, so the render-side imports
 * of `feedRows.tsx` (PostItem, the interstitial cards, Bloom, the hover store) are
 * mocked out: they pull the whole component tree into the jest-expo environment
 * and none of them participate in row construction.
 */

import type { FeedInterstitialSlot, FeedPostSlice, HydratedPost } from '@mention/shared-types';
import {
    buildFeedRows,
    feedRowKey,
    feedRowType,
    type FeedRow,
    type InterstitialFeedRow,
    type PostFeedRow,
} from '../feedRows';

(globalThis as { __DEV__?: boolean }).__DEV__ = false;

// Hoisted above the imports by babel-jest, so `feedRows` resolves these mocks.
jest.mock('../PostItem', () => ({ __esModule: true, default: () => null }));
jest.mock('../PostErrorBoundary', () => ({ __esModule: true, PostErrorBoundary: () => null }));
jest.mock('../interstitials/FeedInterstitial', () => ({ __esModule: true, default: () => null }));
jest.mock('@oxyhq/bloom/subtle-hover', () => ({ __esModule: true, SubtleHover: () => null }));
jest.mock('@/stores/threadHoverStore', () => ({ __esModule: true, useThreadHoverStore: () => undefined }));

// ── Fixtures ────────────────────────────────────────────────────────────────

/** Minimal post shape the row builder actually reads: `id` and `user.id`. */
function post(id: string, authorId: string = 'author-1'): HydratedPost {
    return { id, user: { id: authorId } } as unknown as HydratedPost;
}

/** A standalone (single-post) slice. Its key mirrors the backend's: the post id. */
function slice(id: string, authorId?: string): FeedPostSlice {
    return {
        _sliceKey: id,
        isIncompleteThread: false,
        items: [{
            post: post(id, authorId),
            isThreadParent: false,
            isThreadChild: false,
            isThreadLastChild: false,
        }],
    };
}

/** A thread slice: several posts under ONE slice key (the backend joins ids with '+'). */
function threadSlice(ids: string[], authorId?: string): FeedPostSlice {
    return {
        _sliceKey: ids.join('+'),
        isIncompleteThread: false,
        items: ids.map((id, i) => ({
            post: post(id, authorId),
            isThreadParent: i < ids.length - 1,
            isThreadChild: i > 0,
            isThreadLastChild: i === ids.length - 1 && i > 0,
        })),
    };
}

function slot(kind: FeedInterstitialSlot['kind'], afterSliceKey: string): FeedInterstitialSlot {
    return { key: `int:${kind}:${afterSliceKey}`, kind, afterSliceKey };
}

const NO_BLOCKS = new Set<string>();

function build(params: {
    slices?: FeedPostSlice[];
    items?: HydratedPost[];
    interstitials?: FeedInterstitialSlot[];
    blockedSet?: Set<string>;
}): FeedRow[] {
    return buildFeedRows({
        slices: params.slices,
        items: params.items ?? [],
        interstitials: params.interstitials,
        type: 'for_you',
        blockedSet: params.blockedSet ?? NO_BLOCKS,
    });
}

/** Narrowing helpers — a failed cast here would silently pass a wrong assertion. */
function asPost(row: FeedRow): PostFeedRow {
    if (row.kind !== 'post') throw new Error(`expected a post row, got ${row.kind}`);
    return row;
}

function asInterstitial(row: FeedRow): InterstitialFeedRow {
    if (row.kind !== 'interstitial') throw new Error(`expected an interstitial row, got ${row.kind}`);
    return row;
}

/** The row layout as a readable list: post ids and card kinds in feed order. */
function layout(rows: FeedRow[]): string[] {
    return rows.map((row) => (row.kind === 'post' ? String(row.item.id) : `card:${row.slot.kind}`));
}

// ── Placement ───────────────────────────────────────────────────────────────

describe('buildFeedRows — interstitial placement', () => {
    it('splices a slot directly after its anchor slice', () => {
        const rows = build({
            slices: [slice('p1'), slice('p2'), slice('p3')],
            interstitials: [slot('suggestedUsers', 'p2')],
        });

        expect(layout(rows)).toEqual(['p1', 'p2', 'card:suggestedUsers', 'p3']);
        expect(asInterstitial(rows[2]).slot.afterSliceKey).toBe('p2');
    });

    it('splices a slot after the LAST row of a thread slice, never inside the thread', () => {
        const thread = threadSlice(['t1', 't2', 't3']);
        const rows = build({
            slices: [slice('p1'), thread, slice('p2')],
            interstitials: [slot('suggestedFeeds', thread._sliceKey)],
        });

        expect(layout(rows)).toEqual(['p1', 't1', 't2', 't3', 'card:suggestedFeeds', 'p2']);
    });

    it('places a slot anchored to the last slice at the very end of the feed', () => {
        const rows = build({
            slices: [slice('p1'), slice('p2')],
            interstitials: [slot('suggestedStarterPacks', 'p2')],
        });

        expect(layout(rows)).toEqual(['p1', 'p2', 'card:suggestedStarterPacks']);
    });

    it('discards a slot whose anchor slice was dropped by the blocked-author filter', () => {
        const rows = build({
            slices: [slice('p1', 'author-1'), slice('p2', 'blocked-author'), slice('p3', 'author-1')],
            interstitials: [slot('suggestedUsers', 'p2')],
            blockedSet: new Set(['blocked-author']),
        });

        // p2 never made it into the rows, so its card must not re-anchor elsewhere.
        expect(layout(rows)).toEqual(['p1', 'p3']);
    });

    it('keeps the surviving slots when a sibling slot is discarded, and renumbers ordinals over what was emitted', () => {
        const rows = build({
            slices: [slice('p1', 'author-1'), slice('p2', 'blocked-author'), slice('p3', 'author-1')],
            interstitials: [slot('suggestedUsers', 'p2'), slot('suggestedFeeds', 'p3')],
            blockedSet: new Set(['blocked-author']),
        });

        expect(layout(rows)).toEqual(['p1', 'p3', 'card:suggestedFeeds']);
        // The discarded slot must not burn ordinal 0 — the emitted card is the first.
        expect(asInterstitial(rows[2]).ordinal).toBe(0);
    });

    it('discards a slot whose anchor slice is not in the feed at all', () => {
        const rows = build({
            slices: [slice('p1')],
            interstitials: [slot('suggestedUsers', 'p-does-not-exist')],
        });

        expect(layout(rows)).toEqual(['p1']);
    });

    it('numbers ordinals correlatively in feed order', () => {
        const rows = build({
            slices: [slice('p1'), slice('p2'), slice('p3')],
            interstitials: [
                slot('suggestedUsers', 'p1'),
                slot('suggestedFeeds', 'p2'),
                slot('suggestedStarterPacks', 'p3'),
            ],
        });

        const ordinals = rows.filter((r) => r.kind === 'interstitial').map((r) => asInterstitial(r).ordinal);
        expect(ordinals).toEqual([0, 1, 2]);
        expect(layout(rows)).toEqual([
            'p1', 'card:suggestedUsers',
            'p2', 'card:suggestedFeeds',
            'p3', 'card:suggestedStarterPacks',
        ]);
    });

    it('anchors on the flat-items path too (a single-post slice key is the post id)', () => {
        const rows = build({
            items: [post('p1'), post('p2')],
            interstitials: [slot('suggestedUsers', 'p1')],
        });

        expect(layout(rows)).toEqual(['p1', 'card:suggestedUsers', 'p2']);
    });

    it('emits no card for an empty feed', () => {
        const rows = build({ items: [], interstitials: [slot('suggestedUsers', 'p1')] });
        expect(rows).toEqual([]);
    });
});

// ── Regression guard: a feed without interstitials is unchanged ──────────────

describe('buildFeedRows — no interstitials (regression guard)', () => {
    const slices = [slice('p1'), threadSlice(['t1', 't2']), slice('p2')];

    it('produces the same rows whether the field is absent or an empty array', () => {
        const withoutField = build({ slices });
        const withEmptyArray = build({ slices, interstitials: [] });

        expect(withoutField).toEqual(withEmptyArray);
        expect(withoutField.every((row) => row.kind === 'post')).toBe(true);
        expect(layout(withoutField)).toEqual(['p1', 't1', 't2', 'p2']);
    });

    it('carries the thread state of every post row through untouched', () => {
        const rows = build({ slices });
        const [p1, t1, t2, p2] = rows.map(asPost);

        expect(p1).toMatchObject({ sliceKey: 'p1', isThreadParent: false, isThreadChild: false, nestingDepth: 0 });
        expect(t1).toMatchObject({ sliceKey: 't1+t2', isThreadParent: true, isThreadChild: false, threadRootId: 't1' });
        expect(t2).toMatchObject({ sliceKey: 't1+t2', isThreadParent: false, isThreadChild: true, isThreadLastChild: true, threadRootId: 't1' });
        expect(p2).toMatchObject({ sliceKey: 'p2', isThreadParent: false });
    });
});

// ── Row identity helpers ────────────────────────────────────────────────────

describe('feedRowKey', () => {
    it('keys a standalone post row by its post id', () => {
        const [row] = build({ slices: [slice('p1')] });
        expect(feedRowKey(row)).toBe('p1');
    });

    it('scopes a thread post row by its slice key', () => {
        const rows = build({ slices: [threadSlice(['t1', 't2'])] });
        expect(feedRowKey(rows[0])).toBe('t1+t2:t1');
        expect(feedRowKey(rows[1])).toBe('t1+t2:t2');
    });

    it('keys an interstitial row by the slot key the server issued', () => {
        const rows = build({ slices: [slice('p1')], interstitials: [slot('suggestedUsers', 'p1')] });
        expect(feedRowKey(rows[1])).toBe('int:suggestedUsers:p1');
    });

    it('gives every row of a feed a distinct key', () => {
        const rows = build({
            slices: [slice('p1'), threadSlice(['t1', 't2']), slice('p2')],
            interstitials: [slot('suggestedUsers', 'p1'), slot('suggestedFeeds', 'p2')],
        });
        const keys = rows.map(feedRowKey);
        expect(new Set(keys).size).toBe(keys.length);
    });
});

describe('feedRowType', () => {
    it('buckets a plain post row as a post', () => {
        const [row] = build({ slices: [slice('p1')] });
        expect(feedRowType(row)).toBe('post');
    });

    it('buckets thread rows by their thread position', () => {
        const rows = build({ slices: [threadSlice(['t1', 't2'])] });
        expect(feedRowType(rows[0])).toBe('threadParent');
        expect(feedRowType(rows[1])).toBe('threadChild');
    });

    it('gives each interstitial kind its own recycle bucket, distinct from any post bucket', () => {
        const rows = build({
            slices: [slice('p1'), slice('p2'), slice('p3')],
            interstitials: [
                slot('suggestedUsers', 'p1'),
                slot('suggestedFeeds', 'p2'),
                slot('suggestedStarterPacks', 'p3'),
            ],
        });

        const cardTypes = rows.filter((r) => r.kind === 'interstitial').map(feedRowType);
        expect(cardTypes).toEqual([
            'interstitial:suggestedUsers',
            'interstitial:suggestedFeeds',
            'interstitial:suggestedStarterPacks',
        ]);

        const postTypes = new Set(rows.filter((r) => r.kind === 'post').map(feedRowType));
        for (const cardType of cardTypes) {
            expect(postTypes.has(cardType)).toBe(false);
        }
    });
});
