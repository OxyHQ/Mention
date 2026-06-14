/**
 * Tests for buildFeedScrollKey — the stable feed-identity key used to retain
 * scroll position and (in memory mode) feed items across an unmount→remount.
 *
 * Stability is the load-bearing property: the same logical feed must always
 * produce the same key (so the saved offset and cached items restore exactly),
 * while distinct feeds must produce distinct keys (so they never collide).
 *
 * `buildFeedScrollKey` lives in `utils/feedUtils` and only depends on type-only
 * imports from `@mention/shared-types`, so it transforms cleanly under jest-expo
 * without pulling in SQLite, Zustand, or the network layer.
 */

// jest-expo's Babel config does not support TS type assertions in expression
// position, so we use Object.assign to set __DEV__ without a cast.
Object.assign(globalThis, { __DEV__: false });

import { buildFeedScrollKey, FeedFilters } from '../feedUtils';

describe('buildFeedScrollKey', () => {
    it('produces the same key for identical inputs', () => {
        const a = buildFeedScrollKey({ type: 'for_you' });
        const b = buildFeedScrollKey({ type: 'for_you' });
        expect(a).toBe(b);
    });

    it('is stable regardless of filter key ordering', () => {
        const a = buildFeedScrollKey({
            type: 'hashtag',
            filters: { hashtag: 'react', topic: 'tech' } as FeedFilters,
        });
        const b = buildFeedScrollKey({
            type: 'hashtag',
            filters: { topic: 'tech', hashtag: 'react' } as FeedFilters,
        });
        expect(a).toBe(b);
    });

    it('distinguishes feeds by type', () => {
        expect(buildFeedScrollKey({ type: 'for_you' })).not.toBe(
            buildFeedScrollKey({ type: 'following' }),
        );
    });

    it('distinguishes feeds by userId', () => {
        expect(buildFeedScrollKey({ type: 'posts', userId: 'u1' })).not.toBe(
            buildFeedScrollKey({ type: 'posts', userId: 'u2' }),
        );
    });

    it('distinguishes feeds by filter values', () => {
        expect(
            buildFeedScrollKey({ type: 'hashtag', filters: { hashtag: 'react' } as FeedFilters }),
        ).not.toBe(
            buildFeedScrollKey({ type: 'hashtag', filters: { hashtag: 'vue' } as FeedFilters }),
        );
    });

    it('collapses showOnlySaved to the saved effective type', () => {
        const saved = buildFeedScrollKey({ type: 'for_you', showOnlySaved: true });
        const explicit = buildFeedScrollKey({ type: 'saved' });
        expect(saved).toBe(explicit);
    });

    it('treats no filters and empty filters as equivalent', () => {
        const none = buildFeedScrollKey({ type: 'for_you' });
        const empty = buildFeedScrollKey({ type: 'for_you', filters: {} as FeedFilters });
        expect(none).toBe(empty);
    });

    it('treats missing userId and empty userId as equivalent', () => {
        expect(buildFeedScrollKey({ type: 'for_you' })).toBe(
            buildFeedScrollKey({ type: 'for_you', userId: '' }),
        );
    });

    it('does not collide a userId feed with a filter feed that share text', () => {
        const userFeed = buildFeedScrollKey({ type: 'posts', userId: 'react' });
        const filterFeed = buildFeedScrollKey({
            type: 'posts',
            filters: { hashtag: 'react' } as FeedFilters,
        });
        expect(userFeed).not.toBe(filterFeed);
    });
});
