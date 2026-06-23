/**
 * Tests for the cheap equality helpers that replaced JSON.stringify deep
 * comparison on the Feed render hot path.
 *
 *  - `shallowFiltersEqual`: one-level key-by-key equality for the flat FeedFilters
 *    bag (used by `arePropsEqual` in Feed.web.tsx).
 *  - `depsShallowEqual`: element-wise dependency-list equality (used by the
 *    useDeepCompareMemo/Effect hooks). Large arrays / Sets compare by reference;
 *    plain objects (filters) by one shallow pass; primitives by `===`.
 */

import { shallowFiltersEqual, depsShallowEqual } from '../feedUtils';

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

    it('compares large arrays by reference (new ref = changed)', () => {
        const items = [{ id: '1' }, { id: '2' }];
        // Same reference → equal even though contents are deep.
        expect(depsShallowEqual([items], [items])).toBe(true);
        // A new array with identical contents → treated as changed (a feed update
        // always produces a new array reference).
        expect(depsShallowEqual([items], [[{ id: '1' }, { id: '2' }]])).toBe(false);
    });

    it('compares plain objects (filters) by one shallow pass', () => {
        // Rebuilt-but-equal filters object → equal (no false invalidation).
        expect(
            depsShallowEqual([{ hashtag: 'expo' }], [{ hashtag: 'expo' }]),
        ).toBe(true);
        // Real change → not equal.
        expect(
            depsShallowEqual([{ hashtag: 'expo' }], [{ hashtag: 'react' }]),
        ).toBe(false);
    });

    it('compares a Set (blockedSet) by reference', () => {
        const blocked = new Set(['u1']);
        expect(depsShallowEqual([blocked], [blocked])).toBe(true);
        // A new Set with identical membership is treated as changed — the store
        // only allocates a new Set when membership actually changes, so this is
        // both correct and strictly better than the old JSON path (which
        // serialized a Set to `{}` and never detected its changes at all).
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
