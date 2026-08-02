import { queryClient } from '@/lib/queryClient';
import { viewerQueryKeys } from '@/lib/viewerQueryKeys';
import {
  invalidateSafetyFilters,
  isFeedCacheStaleForSafety,
  resetSafetyInvalidation,
  subscribeToSafetyFilterChanges,
} from '../safetyInvalidation';

/**
 * The authority has to reach BOTH read caches, and the React Query half is the
 * one that cannot be seen from a feed test: search results and the notifications
 * list are filtered by the server with the same two rules, and they live under
 * query keys, not in the feed store.
 *
 * The family tokens are the whole risk here — `isFamily` matches one position of
 * a key, so a token that reads plausibly but does not match ('notificationsRoot',
 * 'feeds') silently invalidates nothing. Hence a real `QueryClient` with real
 * keys, and an unrelated family asserted to be left alone so a predicate that
 * matched everything could not pass either.
 */

const VIEWER_ID = 'viewer-a';

function wasInvalidated(key: readonly unknown[]): boolean {
  return queryClient.getQueryState(key)?.isInvalidated === true;
}

describe('the safety-filter authority', () => {
  beforeEach(() => {
    resetSafetyInvalidation();
    queryClient.clear();
  });

  afterAll(() => {
    queryClient.clear();
  });

  it('invalidates exactly the query families the server filters by these rules', () => {
    const search = viewerQueryKeys.search(VIEWER_ID, 'posts', 'dogs', true);
    const notifications = viewerQueryKeys.notifications(VIEWER_ID);
    const unrelated = viewerQueryKeys.scheduledPosts(VIEWER_ID);

    for (const key of [search, notifications, unrelated]) {
      queryClient.setQueryData(key, []);
    }

    invalidateSafetyFilters();

    expect(wasInvalidated(search)).toBe(true);
    expect(wasInvalidated(notifications)).toBe(true);
    // A muted word cannot change what the viewer has scheduled to post.
    expect(wasInvalidated(unrelated)).toBe(false);
  });

  it('marks a feed cache retained before the change as stale, and one retained after as current', () => {
    const beforeChange = Date.now() - 1;
    expect(isFeedCacheStaleForSafety(beforeChange)).toBe(false);

    invalidateSafetyFilters();

    expect(isFeedCacheStaleForSafety(beforeChange)).toBe(true);
    expect(isFeedCacheStaleForSafety(Date.now() + 1)).toBe(false);
  });

  it('stops notifying a subscriber that has unsubscribed', () => {
    const listener = jest.fn();
    const unsubscribe = subscribeToSafetyFilterChanges(listener);

    invalidateSafetyFilters();
    expect(listener).toHaveBeenCalledTimes(1);

    // An unmounted feed must not be woken, or a screen the viewer left would
    // issue a request nothing is waiting for.
    unsubscribe();
    invalidateSafetyFilters();
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
