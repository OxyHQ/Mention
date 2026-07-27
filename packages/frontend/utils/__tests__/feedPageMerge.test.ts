import type {
    FeedInterstitialSlot,
    FeedPostSlice,
    HydratedPost,
} from '@mention/shared-types';
import { mergeFeedPageContent } from '../feedUtils';

function post(id: string): HydratedPost {
    return { id, user: { id: `author-${id}` } } as unknown as HydratedPost;
}

function slice(key: string, ids: string[]): FeedPostSlice {
    return {
        _sliceKey: key,
        isIncompleteThread: false,
        items: ids.map((id, index) => ({
            post: post(id),
            isThreadParent: index < ids.length - 1,
            isThreadChild: index > 0,
            isThreadLastChild: index === ids.length - 1 && index > 0,
        })),
    };
}

function slot(key: string, afterSliceKey: string): FeedInterstitialSlot {
    return {
        key,
        kind: 'suggestedUsers',
        afterSliceKey,
    };
}

describe('mergeFeedPageContent', () => {
    it('preserves order while removing flat page-boundary overlap', () => {
        const merged = mergeFeedPageContent(
            { items: [post('p1'), post('p2')] },
            { items: [post('p2'), post('p3')] },
        );

        expect(merged.items.map((item) => item.id)).toEqual(['p1', 'p2', 'p3']);
    });

    it('deduplicates posts globally inside slices and drops slices left empty', () => {
        const merged = mergeFeedPageContent(
            {
                items: [post('p1'), post('p2')],
                slices: [slice('thread-1', ['p1', 'p2'])],
            },
            {
                items: [post('p2'), post('p3')],
                slices: [
                    slice('thread-2', ['p2', 'p3']),
                    slice('duplicate-only', ['p1']),
                ],
            },
        );

        expect(merged.slices?.map((entry) => ({
            key: entry._sliceKey,
            ids: entry.items.map((item) => item.post.id),
        }))).toEqual([
            { key: 'thread-1', ids: ['p1', 'p2'] },
            { key: 'thread-2', ids: ['p3'] },
        ]);
    });

    it('deduplicates repeated posts within one slice without changing its key', () => {
        const merged = mergeFeedPageContent(undefined, {
            items: [post('p1')],
            slices: [slice('stable-anchor', ['p1', 'p1'])],
        });

        expect(merged.slices).toHaveLength(1);
        expect(merged.slices?.[0]._sliceKey).toBe('stable-anchor');
        expect(merged.slices?.[0].items.map((item) => item.post.id)).toEqual(['p1']);
    });

    it('keeps the first slot by key and removes slots whose anchor disappeared', () => {
        const merged = mergeFeedPageContent(
            {
                items: [post('p1')],
                slices: [slice('s1', ['p1'])],
                interstitials: [slot('slot-1', 's1')],
            },
            {
                items: [post('p1'), post('p2')],
                slices: [slice('s2', ['p1']), slice('s3', ['p2'])],
                interstitials: [
                    slot('slot-1', 's3'),
                    slot('orphaned', 's2'),
                    slot('slot-3', 's3'),
                ],
            },
        );

        expect(merged.slices?.map((entry) => entry._sliceKey)).toEqual(['s1', 's3']);
        expect(merged.interstitials).toEqual([
            slot('slot-1', 's1'),
            slot('slot-3', 's3'),
        ]);
    });

    it('does not collapse a boost wrapper into its original post', () => {
        const original = post('original');
        const boost = {
            ...post('boost-wrapper'),
            boost: {
                actor: post('booster').user,
                originalPost: original,
            },
        } as unknown as HydratedPost;

        const merged = mergeFeedPageContent(undefined, {
            items: [original, boost],
        });

        expect(merged.items.map((item) => item.id)).toEqual([
            'original',
            'boost-wrapper',
        ]);
    });
});
