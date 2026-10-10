import type { InfiniteData } from '@tanstack/react-query';
import type { FeedPostSlice, HydratedPost } from '@mention/shared-types';
import { queryClient } from '@/lib/queryClient';
import { viewerQueryKeys, type FeedQueryIdentity } from '@/lib/viewerQueryKeys';
import { advanceLocalPostRevision } from '@/stores/feedScrollStore';
import {
    feedReceivesOwnNewPost,
    feedThreadParentId,
    getItemKey,
    mergeFeedPageContent,
    type MergedFeedPageContent,
} from '@/utils/feedUtils';

/**
 * The feed queries' cache: what one page of a feed holds, how the pages fold
 * into what a feed renders, and the viewer's own writes into it.
 *
 * Every feed `useFeedState` serves in memory mode — all of web, and every scoped
 * feed on native — is one infinite query (`hooks/useFeedQuery`). A post the
 * viewer creates, replies with or deletes has to reach those feeds whether or not
 * they are mounted: on web the composer REPLACES the home feed, so at the moment
 * of publishing nothing is listening, and the feed warm-starts from this cache
 * when the viewer comes back. Writing into the cache reaches a mounted feed and
 * an unmounted one by the same path.
 *
 * The native SQLite feeds take the same writes through `postsStore`'s own SQLite
 * inserts and removals; nothing here touches them.
 */

/** One page of a feed, normalised (`mergeFeedPageContent`) as it was read. */
export interface FeedPage extends MergedFeedPageContent {
    hasMore: boolean;
    nextCursor?: string;
    /**
     * The server answered `pending` with nothing to show: a federated profile
     * whose ActivityPub outbox is still syncing in the background.
     */
    pending: boolean;
}

/** A page's cursor; the first page has none. */
export type FeedPageParam = string | undefined;

export type FeedQueryData = InfiniteData<FeedPage, FeedPageParam>;

// ---------------------------------------------------------------------------
// Pure functions — no React, no QueryClient. Each reducer returns the SAME
// object when nothing changed, so a write that does not apply to a feed costs
// that feed no cache update and no re-render.
// ---------------------------------------------------------------------------

/**
 * The loaded pages as one feed: items, slices and recommendation-card
 * placements, in first-seen order with every page-boundary overlap removed.
 * Card slots anchor to slices of the page that carried them, so folding the
 * pages in order keeps every card at its position in the accumulated feed.
 */
export function foldFeedPages(pages: readonly FeedPage[]): MergedFeedPageContent {
    return mergeFeedPageContent(undefined, {
        items: pages.flatMap((page) => page.items),
        slices: pages.flatMap((page) => page.slices ?? []),
        interstitials: pages.flatMap((page) => page.interstitials ?? []),
    });
}

/** A single-post slice for a post the viewer just created. */
function localPostSlice(post: HydratedPost): FeedPostSlice {
    return {
        _sliceKey: `local-new:${getItemKey(post)}`,
        isIncompleteThread: false,
        items: [{ post, isThreadParent: false, isThreadChild: false, isThreadLastChild: false }],
    };
}

/**
 * Put a post at the top of a feed: its first page's items, and its slices when
 * the feed renders by slice. Unchanged when the post is already there.
 */
export function prependFeedPost(data: FeedQueryData, post: HydratedPost): FeedQueryData {
    const [first, ...rest] = data.pages;
    if (!first) return data;
    const key = getItemKey(post);
    if (data.pages.some((page) => page.items.some((item) => getItemKey(item) === key))) return data;

    // A feed that renders by slice would not show the post from its items alone.
    const rendersBySlice = data.pages.some((page) => (page.slices?.length ?? 0) > 0);
    const inASlice = data.pages.some((page) =>
        page.slices?.some((slice) => slice.items.some((sliceItem) => getItemKey(sliceItem.post) === key)));
    const slices = rendersBySlice && !inASlice
        ? [localPostSlice(post), ...(first.slices ?? [])]
        : first.slices;
    return { ...data, pages: [{ ...first, items: [post, ...first.items], slices }, ...rest] };
}

/**
 * Drop a post from every page: its items, and its slices — a slice it leaves
 * empty goes with it. A card anchored to that slice has nothing to sit after
 * any more; `foldFeedPages` drops it.
 */
export function removeFeedPost(data: FeedQueryData, postId: string): FeedQueryData {
    let changed = false;
    const pages = data.pages.map((page) => {
        const items = page.items.filter((item) => getItemKey(item) !== postId);
        let slicesChanged = false;
        const slices = page.slices
            ?.map((slice) => {
                const sliceItems = slice.items.filter((sliceItem) => getItemKey(sliceItem.post) !== postId);
                if (sliceItems.length === slice.items.length) return slice;
                slicesChanged = true;
                return { ...slice, items: sliceItems };
            })
            .filter((slice) => slice.items.length > 0);
        if (items.length === page.items.length && !slicesChanged) return page;
        changed = true;
        return { ...page, items, slices: slicesChanged ? slices : page.slices };
    });
    return changed ? { ...data, pages } : data;
}

// ---------------------------------------------------------------------------
// The viewer's own writes. Called by `postsStore` after the server accepted
// them, next to the SQLite path's own insert or removal.
// ---------------------------------------------------------------------------

/**
 * Apply `update` to every loaded feed query `matches` selects.
 *
 * One `setQueryData` per query rather than one `setQueriesData` over them all,
 * because each keeps its OWN read time: the viewer's own write does not make a
 * feed any fresher than the server read it came from, and the staleness rules
 * (`stores/feedStaleness`) judge a warm start by that time. `setQueriesData`
 * would stamp every feed with one time — now — and a feed read before a like
 * would warm-start as if it postdated it.
 */
function updateFeedQueries(
    matches: (feed: FeedQueryIdentity) => boolean,
    update: (data: FeedQueryData) => FeedQueryData,
): void {
    const loaded = queryClient.getQueriesData<FeedQueryData>({
        predicate: (query) => {
            const feed = viewerQueryKeys.feedIdentity(query.queryKey);
            return feed !== null && matches(feed);
        },
    });
    for (const [queryKey, data] of loaded) {
        if (!data) continue;
        const next = update(data);
        if (next === data) continue;
        queryClient.setQueryData<FeedQueryData>(queryKey, next, {
            updatedAt: queryClient.getQueryState(queryKey)?.dataUpdatedAt,
        });
    }
}

/**
 * Put a post the viewer just created at the top of every feed it belongs in —
 * the home feeds and the author's own profile posts (`feedReceivesOwnNewPost`),
 * mounted or not — and advance the revision that brings it into view.
 */
export function publishNewLocalPost(post: HydratedPost): void {
    const authorId = post.user?.id ? String(post.user.id) : undefined;
    updateFeedQueries(
        (feed) => feedReceivesOwnNewPost({ ...feed, currentUserId: authorId }),
        (data) => prependFeedPost(data, post),
    );
    advanceLocalPostRevision();
}

/**
 * Put a reply the server accepted on top of the thread it answers
 * (OxyHQ/Mention#1140). A thread's replies feed is SCOPED, so a new post never
 * belongs in it — but the viewer's own reply to that thread does, the way it
 * lands in every threaded app; the next read puts it wherever the server sorts
 * it. Matched on the same parent id the feed's read narrows its results to, so
 * the feed only ever holds what a read of it could have returned.
 */
export function publishNewLocalReply(reply: HydratedPost): void {
    const parentId = String(reply.parentPostId ?? '');
    if (!parentId) return;
    updateFeedQueries(
        (feed) => feed.type === 'replies'
            && feedThreadParentId(feed.filters) === parentId,
        (data) => prependFeedPost(data, reply),
    );
}

/** Drop a removed post from every feed that holds it — a deleted post vanishes everywhere. */
export function publishRemovedLocalPost(postId: string): void {
    updateFeedQueries(() => true, (data) => removeFeedPost(data, postId));
}
