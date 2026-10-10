import type { FeedInterstitialSlot, FeedPostSlice, HydratedPost } from '@mention/shared-types';
import { queryClient } from '@/lib/queryClient';
import { viewerQueryKeys } from '@/lib/viewerQueryKeys';
import {
    foldFeedPages,
    prependFeedPost,
    publishNewLocalPost,
    publishRemovedLocalPost,
    removeFeedPost,
    type FeedPage,
    type FeedQueryData,
} from '../feedQueryCache';

function post(id: string, author: string = `author-${id}`): HydratedPost {
    return { id, user: { id: author } } as unknown as HydratedPost;
}

function slice(key: string, ...postIds: string[]): FeedPostSlice {
    return {
        _sliceKey: key,
        isIncompleteThread: false,
        items: postIds.map((id) => ({
            post: post(id),
            isThreadParent: false,
            isThreadChild: false,
            isThreadLastChild: false,
        })),
    };
}

function card(key: string, afterSliceKey: string): FeedInterstitialSlot {
    return { key, afterSliceKey } as unknown as FeedInterstitialSlot;
}

function feedPage(itemIds: string[], extra: Partial<FeedPage> = {}): FeedPage {
    return { items: itemIds.map((id) => post(id)), hasMore: false, pending: false, ...extra };
}

function data(...pages: FeedPage[]): FeedQueryData {
    return { pages, pageParams: pages.map((_, index) => (index === 0 ? undefined : `cursor-${index}`)) };
}

function itemIds(value: FeedQueryData | undefined): string[][] {
    return (value?.pages ?? []).map((page) => page.items.map((item) => item.id));
}

describe('foldFeedPages', () => {
    it('folds the pages in order, drops page-boundary repeats, and keeps a card only with its slice', () => {
        const folded = foldFeedPages([
            feedPage(['a', 'b'], { slices: [slice('s-a', 'a'), slice('s-b', 'b')], interstitials: [card('c1', 's-a')] }),
            feedPage(['b', 'c'], { slices: [slice('s-b', 'b'), slice('s-c', 'c')], interstitials: [card('c2', 's-gone')] }),
        ]);

        expect(folded.items.map((item) => item.id)).toEqual(['a', 'b', 'c']);
        expect(folded.slices?.map((s) => s._sliceKey)).toEqual(['s-a', 's-b', 's-c']);
        expect(folded.interstitials?.map((slot) => slot.key)).toEqual(['c1']);
    });

    it('folds no pages into an empty feed', () => {
        expect(foldFeedPages([])).toEqual({ items: [], slices: undefined, interstitials: undefined });
    });
});

describe('prependFeedPost', () => {
    it('puts the post at the top of the first page and leaves the later pages alone', () => {
        const before = data(feedPage(['a']), feedPage(['b']));
        const after = prependFeedPost(before, post('mine'));

        expect(itemIds(after)).toEqual([['mine', 'a'], ['b']]);
        expect(after.pages[1]).toBe(before.pages[1]);
        expect(after.pages[0].slices).toBeUndefined();
    });

    it('adds a slice only to a feed that renders by slice', () => {
        const after = prependFeedPost(data(feedPage(['a']), feedPage(['b'], { slices: [slice('s-b', 'b')] })), post('mine'));

        expect(after.pages[0].slices?.map((s) => s._sliceKey)).toEqual(['local-new:mine']);
    });

    it('returns the same data when the post is already there, or there is no page to put it on', () => {
        const holding = data(feedPage(['mine']));
        expect(prependFeedPost(holding, post('mine'))).toBe(holding);

        const empty: FeedQueryData = { pages: [], pageParams: [] };
        expect(prependFeedPost(empty, post('mine'))).toBe(empty);
    });

    it('does not slice a post twice when a slice already carries it', () => {
        const before = data(feedPage([], { slices: [slice('s-mine', 'mine')] }));
        const after = prependFeedPost(before, post('mine'));

        expect(itemIds(after)).toEqual([['mine']]);
        expect(after.pages[0].slices?.map((s) => s._sliceKey)).toEqual(['s-mine']);
    });
});

describe('removeFeedPost', () => {
    it('drops the post from every page, its slices, and a slice it leaves empty', () => {
        const before = data(
            feedPage(['a', 'gone'], { slices: [slice('s-a', 'a'), slice('s-gone', 'gone')] }),
            feedPage(['b'], { slices: [slice('s-thread', 'b', 'gone')] }),
            feedPage(['c']),
        );
        const after = removeFeedPost(before, 'gone');

        expect(itemIds(after)).toEqual([['a'], ['b'], ['c']]);
        expect(after.pages[0].slices?.map((s) => s._sliceKey)).toEqual(['s-a']);
        expect(after.pages[1].slices?.[0].items.map((si) => si.post.id)).toEqual(['b']);
        expect(after.pages[2]).toBe(before.pages[2]);
    });

    it('returns the same data when the post is not there', () => {
        const before = data(feedPage(['a'], { slices: [slice('s-a', 'a')] }));
        expect(removeFeedPost(before, 'gone')).toBe(before);
    });
});

describe('the viewer\'s own writes into the feed queries', () => {
    const homeKey = viewerQueryKeys.feed('viewer-a', 'for_you');
    const exploreKey = viewerQueryKeys.feed('viewer-a', 'explore');
    const threadKey = viewerQueryKeys.feed('viewer-a', 'replies', undefined, { postId: 'root' });

    beforeEach(() => {
        queryClient.clear();
    });

    it('removes a post from every feed that holds it, mounted or not', () => {
        queryClient.setQueryData<FeedQueryData>(homeKey, data(feedPage(['a', 'gone'])));
        queryClient.setQueryData<FeedQueryData>(threadKey, data(feedPage(['gone'])));
        queryClient.setQueryData<FeedQueryData>(exploreKey, data(feedPage(['b'])));
        const untouched = queryClient.getQueryData<FeedQueryData>(exploreKey);

        publishRemovedLocalPost('gone');

        expect(itemIds(queryClient.getQueryData<FeedQueryData>(homeKey))).toEqual([['a']]);
        expect(itemIds(queryClient.getQueryData<FeedQueryData>(threadKey))).toEqual([[]]);
        expect(queryClient.getQueryData<FeedQueryData>(exploreKey)).toBe(untouched);
    });

    it('keeps each feed\'s own read time, so a write never makes it look fresher', () => {
        queryClient.setQueryData<FeedQueryData>(homeKey, data(feedPage(['a'])), { updatedAt: 1_000 });
        queryClient.setQueryData<FeedQueryData>(viewerQueryKeys.feed('viewer-a', 'following'), data(feedPage(['b'])), { updatedAt: 2_000 });

        publishNewLocalPost(post('mine', 'viewer-a'));
        publishRemovedLocalPost('a');

        expect(queryClient.getQueryState(homeKey)?.dataUpdatedAt).toBe(1_000);
        expect(queryClient.getQueryState(viewerQueryKeys.feed('viewer-a', 'following'))?.dataUpdatedAt).toBe(2_000);
        expect(itemIds(queryClient.getQueryData<FeedQueryData>(homeKey))).toEqual([['mine']]);
    });

    it('skips a feed query that has not loaded yet, and any query that is not a feed', () => {
        const notAFeed = viewerQueryKeys.notifications('viewer-a');
        queryClient.setQueryData(notAFeed, { untouched: true });
        // A feed that is still loading its first page has no data to write into.
        void queryClient.prefetchQuery({ queryKey: homeKey, queryFn: () => new Promise<FeedQueryData>(() => undefined) });

        publishNewLocalPost(post('mine', 'viewer-a'));

        expect(queryClient.getQueryData(homeKey)).toBeUndefined();
        expect(queryClient.getQueryData(notAFeed)).toEqual({ untouched: true });
    });

    it('puts a post with no author on the home feeds only', () => {
        queryClient.setQueryData<FeedQueryData>(homeKey, data(feedPage([])));
        const profileKey = viewerQueryKeys.feed('viewer-a', 'posts', 'viewer-a');
        queryClient.setQueryData<FeedQueryData>(profileKey, data(feedPage([])));

        publishNewLocalPost({ id: 'anonymous' } as unknown as HydratedPost);

        expect(itemIds(queryClient.getQueryData<FeedQueryData>(homeKey))).toEqual([['anonymous']]);
        expect(itemIds(queryClient.getQueryData<FeedQueryData>(profileKey))).toEqual([[]]);
    });
});
