/**
 * Tests for the cheap equality helpers that replaced JSON.stringify deep
 * comparison on the Feed render hot path.
 *
 *  - `shallowFiltersEqual`: one-level key-by-key equality for the flat FeedFilters
 *    bag (used by `arePropsEqual` in the Feed components).
 *  - `feedArrayEqual`: reference short-circuit + full ordered-key equality for
 *    the feed `items`/`slices` arrays.
 *  - `depsShallowEqual`: element-wise dependency-list equality (used by the
 *    useDeepCompareMemo/Effect hooks). Arrays via `feedArrayEqual`; Sets/Maps by
 *    reference; plain objects (filters) by one shallow pass; primitives by `===`.
 *
 * Correctness contract (why this can NOT blank the feed): the `buildFeedRows`
 * memo must recompute only when the SET / ORDER / membership of rows changes.
 * Per-post content updates (likes/replies) reach the row through PostItem's own
 * `dataVersion` store subscription, so they do not need this memo to re-run.
 * Therefore `feedArrayEqual` returns equal only when length AND every ordered key
 * matches — any add/remove/reorder is detected.
 */

import { shallowFiltersEqual, feedArrayEqual, depsShallowEqual } from '../feedUtils';

describe('shallowFiltersEqual', () => {
    it('treats the same reference as equal', () => {
        const f = { hashtag: 'expo' };
        expect(shallowFiltersEqual(f, f)).toBe(true);
    });

    it('treats rebuilt-but-identical filters as equal', () => {
        expect(
            shallowFiltersEqual({ hashtag: 'expo', topic: 'tech' }, { hashtag: 'expo', topic: 'tech' }),
        ).toBe(true);
    });

    it('treats both-undefined as equal', () => {
        expect(shallowFiltersEqual(undefined, undefined)).toBe(true);
    });

    it('treats one-undefined as not equal', () => {
        expect(shallowFiltersEqual({ hashtag: 'expo' }, undefined)).toBe(false);
        expect(shallowFiltersEqual(undefined, { hashtag: 'expo' })).toBe(false);
    });

    it('detects a changed value', () => {
        expect(shallowFiltersEqual({ hashtag: 'expo' }, { hashtag: 'react' })).toBe(false);
    });

    it('detects an added / removed key', () => {
        expect(shallowFiltersEqual({ hashtag: 'expo' }, { hashtag: 'expo', topic: 'tech' })).toBe(false);
        expect(shallowFiltersEqual({ hashtag: 'expo', topic: 'tech' }, { hashtag: 'expo' })).toBe(false);
    });
});

describe('feedArrayEqual', () => {
    const keyOf = (x: { id: string }) => x.id;

    it('treats the same reference as equal', () => {
        const items = [{ id: '1' }, { id: '2' }];
        expect(feedArrayEqual(items, items, keyOf)).toBe(true);
    });

    it('treats both-empty as equal and both-undefined as equal', () => {
        expect(feedArrayEqual([], [], keyOf)).toBe(true);
        expect(feedArrayEqual(undefined, undefined, keyOf)).toBe(true);
    });

    it('treats one-undefined as not equal', () => {
        expect(feedArrayEqual([{ id: '1' }], undefined, keyOf)).toBe(false);
        expect(feedArrayEqual(undefined, [{ id: '1' }], keyOf)).toBe(false);
    });

    it('treats a new array with identical membership/order as equal (no needless recompute)', () => {
        // PostItem sources per-post updates from the store, so an unchanged row set
        // must NOT force buildFeedRows to recompute even on a new array reference.
        expect(
            feedArrayEqual(
                [{ id: '1' }, { id: '2' }, { id: '3' }],
                [{ id: '1' }, { id: '2' }, { id: '3' }],
                keyOf,
            ),
        ).toBe(true);
    });

    it('detects an append (new last key)', () => {
        expect(
            feedArrayEqual([{ id: '1' }, { id: '2' }], [{ id: '1' }, { id: '2' }, { id: '3' }], keyOf),
        ).toBe(false);
    });

    it('detects a prepend (new first key, new length)', () => {
        expect(
            feedArrayEqual([{ id: '2' }, { id: '3' }], [{ id: '1' }, { id: '2' }, { id: '3' }], keyOf),
        ).toBe(false);
    });

    it('detects a removal (length change)', () => {
        expect(
            feedArrayEqual([{ id: '1' }, { id: '2' }, { id: '3' }], [{ id: '1' }, { id: '3' }], keyOf),
        ).toBe(false);
    });

    it('detects an interior reorder even when first, middle, and last keys are unchanged', () => {
        expect(
            feedArrayEqual(
                [{ id: '1' }, { id: '2' }, { id: '3' }, { id: '4' }, { id: '5' }],
                [{ id: '1' }, { id: '4' }, { id: '3' }, { id: '2' }, { id: '5' }],
                keyOf,
            ),
        ).toBe(false);
    });
});

describe('depsShallowEqual', () => {
    it('treats the same reference as equal', () => {
        const deps = ['for_you', 5];
        expect(depsShallowEqual(deps, deps)).toBe(true);
    });

    it('treats differing lengths as not equal', () => {
        expect(depsShallowEqual(['a'], ['a', 'b'])).toBe(false);
    });

    it('compares primitives by ===', () => {
        expect(depsShallowEqual(['for_you', 1, true], ['for_you', 1, true])).toBe(true);
        expect(depsShallowEqual(['for_you', 1, true], ['for_you', 2, true])).toBe(false);
    });

    it('compares arrays via feedArrayEqual (structural change = not equal)', () => {
        const items = [{ id: '1' }, { id: '2' }];
        // Same reference → equal.
        expect(depsShallowEqual([items], [items])).toBe(true);
        // New array, identical membership/order → equal (no needless recompute).
        expect(depsShallowEqual([items], [[{ id: '1' }, { id: '2' }]])).toBe(true);
        // New array with a member added → not equal (real structural change).
        expect(depsShallowEqual([items], [[{ id: '1' }, { id: '2' }, { id: '3' }]])).toBe(false);
    });

    it('compares slice arrays by _sliceKey ordered equality', () => {
        const a = [{ _sliceKey: 's1', items: [] }, { _sliceKey: 's2', items: [] }];
        const b = [{ _sliceKey: 's1', items: [] }, { _sliceKey: 's2', items: [] }];
        expect(depsShallowEqual([a], [b])).toBe(true);
        const c = [{ _sliceKey: 's1', items: [] }, { _sliceKey: 's3', items: [] }];
        expect(depsShallowEqual([a], [c])).toBe(false);
    });

    it('compares plain objects (filters) by one shallow pass', () => {
        expect(depsShallowEqual([{ hashtag: 'expo' }], [{ hashtag: 'expo' }])).toBe(true);
        expect(depsShallowEqual([{ hashtag: 'expo' }], [{ hashtag: 'react' }])).toBe(false);
    });

    it('compares a Set (blockedSet) by reference', () => {
        const blocked = new Set(['u1']);
        expect(depsShallowEqual([blocked], [blocked])).toBe(true);
        // A new Set with identical membership is treated as changed — the store
        // only allocates a new Set when membership actually changes, so this is
        // correct and strictly better than the old JSON path (which serialized a
        // Set to `{}` and never detected its changes at all).
        expect(depsShallowEqual([blocked], [new Set(['u1'])])).toBe(false);
    });

    it('handles null/undefined deps without throwing', () => {
        expect(depsShallowEqual([undefined], [undefined])).toBe(true);
        expect(depsShallowEqual([null], [null])).toBe(true);
        expect(depsShallowEqual([null], [{ a: 1 }])).toBe(false);
        expect(depsShallowEqual([{ a: 1 }], [null])).toBe(false);
    });

    it('does not treat an object vs array as shallow-equal', () => {
        expect(depsShallowEqual([{ 0: 'a' }], [['a']])).toBe(false);
    });
});
