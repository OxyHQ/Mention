import {
  notifyFeedRankingChanged,
  isFeedCacheStaleForRanking,
  subscribeToFeedRankingChanges,
} from '../feedRankingInvalidation';

describe('ranking preferences invalidate held feeds and mounted subscribers', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(1000);
  });
  afterEach(() => jest.useRealTimers());

  it('reloads only the owner after persistence and makes held native/query pages stale', () => {
    const feed = { type: 'following' as const, viewerId: 'settings-owner' };
    const owner = jest.fn();
    const other = jest.fn();
    const unsubscribe = subscribeToFeedRankingChanges(feed, owner);
    const unsubscribeOther = subscribeToFeedRankingChanges({ ...feed, viewerId: 'other' }, other);
    expect(isFeedCacheStaleForRanking(feed, 999)).toBe(false);
    notifyFeedRankingChanged(feed.viewerId);
    expect(owner).toHaveBeenCalledTimes(1);
    expect(other).not.toHaveBeenCalled();
    expect(isFeedCacheStaleForRanking(feed, 999)).toBe(true);
    expect(isFeedCacheStaleForRanking(feed, 1001)).toBe(false);
    unsubscribe();
    unsubscribeOther();
    notifyFeedRankingChanged(feed.viewerId);
    expect(owner).toHaveBeenCalledTimes(1);
  });

  it('tuning refreshes For You, excluding Following, profiles and anonymous readers', () => {
    const home = { type: 'for_you' as const, viewerId: 'tuning-owner' };
    const following = { ...home, type: 'following' as const };
    const callback = jest.fn();
    const unsubscribe = subscribeToFeedRankingChanges(following, callback);
    notifyFeedRankingChanged(home.viewerId, true);
    expect(isFeedCacheStaleForRanking(home, 999)).toBe(true);
    expect(isFeedCacheStaleForRanking(following, 999)).toBe(false);
    expect(isFeedCacheStaleForRanking({ ...home, userId: 'author' }, 999)).toBe(false);
    expect(isFeedCacheStaleForRanking({ type: 'for_you' }, 999)).toBe(false);
    expect(callback).not.toHaveBeenCalled();
    unsubscribe();
  });
});
