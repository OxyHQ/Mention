import { queryClient } from '@/lib/queryClient';
import { viewerQueryKeys } from '@/lib/viewerQueryKeys';
import {
  isFeedCacheStaleForByline,
  noteChannelBylineChanged,
  resetBylineInvalidation,
  subscribeToBylineChanges,
} from '../bylineInvalidation';

/**
 * The authority has to reach BOTH read caches, and the React Query half is the
 * one no feed test can see: a channel's post is embedded in a notification row, a
 * search result, the saved screen and a profile's pinned post, all of which live
 * under query keys rather than in the feed store.
 *
 * The family tokens are the whole risk — `isFamily` matches ONE position of a
 * key, so a token that reads plausibly but does not match ('postsRoot', 'saved',
 * 'notificationsRoot') silently invalidates nothing and every assertion about the
 * feed half still passes. Hence a real `QueryClient` with real keys, plus an
 * unrelated family asserted to be left alone so a predicate that matched
 * everything could not pass either.
 */

const VIEWER_ID = 'viewer-a';
const CHANNEL_ID = 'channel-1';
const OTHER_CHANNEL_ID = 'channel-2';

function wasInvalidated(key: readonly unknown[]): boolean {
  return queryClient.getQueryState(key)?.isInvalidated === true;
}

describe('the channel-byline authority', () => {
  beforeEach(() => {
    resetBylineInvalidation();
    queryClient.clear();
  });

  afterAll(() => {
    queryClient.clear();
  });

  it('invalidates every query family that embeds a post the byline rewrote', () => {
    const postDetail = viewerQueryKeys.post(VIEWER_ID, 'post-1');
    const pinned = viewerQueryKeys.pinnedPost(VIEWER_ID, CHANNEL_ID);
    const scheduled = viewerQueryKeys.scheduledPosts(VIEWER_ID);
    const saved = viewerQueryKeys.savedPosts(VIEWER_ID, '', null);
    const search = viewerQueryKeys.search(VIEWER_ID, 'posts', 'oxy', true);
    const notifications = viewerQueryKeys.notifications(VIEWER_ID);
    const unrelated = viewerQueryKeys.bookmarkFolders(VIEWER_ID);

    for (const key of [postDetail, pinned, scheduled, saved, search, notifications, unrelated]) {
      queryClient.setQueryData(key, []);
    }

    noteChannelBylineChanged(CHANNEL_ID);

    expect(wasInvalidated(postDetail)).toBe(true);
    expect(wasInvalidated(pinned)).toBe(true);
    // Collateral, and pinned as such: `scheduledPosts` shares the `posts` family
    // but cannot itself hold a channel's post — `GET /posts/scheduled` matches
    // the CALLER's `oxyUserId`, and a post published as a channel carries the
    // channel's. The family is the granularity `isFamily` offers; one refetch of
    // a scheduled list is the price, and naming it here stops the next reader
    // from mistaking it for a claim.
    expect(wasInvalidated(scheduled)).toBe(true);
    expect(wasInvalidated(saved)).toBe(true);
    expect(wasInvalidated(search)).toBe(true);
    expect(wasInvalidated(notifications)).toBe(true);
    // A byline names a person on a post; it cannot rename a bookmark folder.
    expect(wasInvalidated(unrelated)).toBe(false);
  });

  it('refetches only the writers list of the channel that changed', () => {
    const changed = viewerQueryKeys.channelWriters(VIEWER_ID, CHANNEL_ID);
    const untouched = viewerQueryKeys.channelWriters(VIEWER_ID, OTHER_CHANNEL_ID);

    for (const key of [changed, untouched]) {
      queryClient.setQueryData(key, { writers: [], nextCursor: undefined });
    }

    noteChannelBylineChanged(CHANNEL_ID);

    // The tab's existence IS this setting — the endpoint 404s for a channel that
    // does not disclose — so the list of the channel that changed has to be asked
    // again. Another channel the reader visited did not change, and on one that
    // does not disclose the refetch would spend a request to re-derive a 404.
    expect(wasInvalidated(changed)).toBe(true);
    expect(wasInvalidated(untouched)).toBe(false);
  });

  it('marks a feed cache retained before the change as stale, and one retained after as current', () => {
    const beforeChange = Date.now() - 1;
    expect(isFeedCacheStaleForByline(beforeChange)).toBe(false);

    noteChannelBylineChanged(CHANNEL_ID);

    expect(isFeedCacheStaleForByline(beforeChange)).toBe(true);
    expect(isFeedCacheStaleForByline(Date.now() + 1)).toBe(false);
  });

  it('condemns a slice retained in the same millisecond as the change', () => {
    // Both stamps are `Date.now()`, so a slice retained and a byline changed close
    // enough together carry the SAME number. A slice retained no later than the
    // change cannot be known to reflect it, and the error the strict `<` makes is
    // leaving a writer's name on screen after their channel stopped disclosing it.
    const now = Date.now();
    const realNow = Date.now;
    Date.now = () => now;
    try {
      noteChannelBylineChanged(CHANNEL_ID);
      expect(isFeedCacheStaleForByline(now)).toBe(true);
    } finally {
      Date.now = realNow;
    }
  });

  it('stops notifying a subscriber that has unsubscribed', () => {
    const listener = jest.fn();
    const unsubscribe = subscribeToBylineChanges(listener);

    noteChannelBylineChanged(CHANNEL_ID);
    expect(listener).toHaveBeenCalledTimes(1);

    // An unmounted feed must not be woken, or a screen the viewer left would
    // issue a request nothing is waiting for.
    unsubscribe();
    noteChannelBylineChanged(CHANNEL_ID);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('forgets the change once reset', () => {
    const beforeChange = Date.now() - 1;
    noteChannelBylineChanged(CHANNEL_ID);
    expect(isFeedCacheStaleForByline(beforeChange)).toBe(true);

    resetBylineInvalidation();

    expect(isFeedCacheStaleForByline(beforeChange)).toBe(false);
  });
});
