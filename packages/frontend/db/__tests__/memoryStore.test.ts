import {
  memSetFeedItems,
  memGetPostById,
  memGetAllFeedItems,
  memClearAll,
  memClearAllFeeds,
} from '../memoryStore';
import type { FeedItem } from '../schema';

describe('memoryStore session clearing', () => {
  const post = {
    id: 'private-post-1',
    content: { text: 'private content' },
  } as unknown as FeedItem;

  afterEach(() => {
    memClearAll();
  });

  it('clears feed indexes without deleting cached posts', () => {
    memSetFeedItems('profile:alice:posts', [post], {
      hasMore: false,
      totalCount: 1,
      lastUpdated: Date.now(),
    });

    memClearAllFeeds();

    expect(memGetAllFeedItems('profile:alice:posts')).toEqual([]);
    expect(memGetPostById('private-post-1')).toBe(post);
  });

  it('clears posts and feed data for viewer session changes', () => {
    memSetFeedItems('profile:alice:posts', [post], {
      hasMore: false,
      totalCount: 1,
      lastUpdated: Date.now(),
    });

    memClearAll();

    expect(memGetPostById('private-post-1')).toBeNull();
    expect(memGetAllFeedItems('profile:alice:posts')).toEqual([]);
  });
});
