import type { FeedItem } from '../schema';
import {
  memClearAll,
  memGetAllFeedItems,
  memGetFeedKeysForPost,
  memGetPostById,
  memRemovePostFromAllFeeds,
  memSetFeedItems,
} from '../memoryStore';

const makePost = (id: string) => ({ id } as FeedItem);

describe('memoryStore feed membership index view', () => {
  beforeEach(() => {
    memClearAll();
  });

  it('reports and removes only feeds that contain the post', () => {
    const target = makePost('memory-target');
    const retained = makePost('memory-retained');
    const meta = {
      hasMore: false,
      totalCount: 1,
      lastUpdated: Date.now(),
    };

    memSetFeedItems('memory:posts', [target], meta);
    memSetFeedItems('memory:following', [target], meta);
    memSetFeedItems('memory:saved', [retained], meta);

    expect(memGetFeedKeysForPost(target.id).sort()).toEqual([
      'memory:following',
      'memory:posts',
    ]);

    memRemovePostFromAllFeeds(target.id);

    expect(memGetFeedKeysForPost(target.id)).toEqual([]);
    expect(memGetFeedKeysForPost(retained.id)).toEqual(['memory:saved']);
  });

  it('clears posts, feed ordering and metadata as one identity boundary', () => {
    const post = makePost('viewer-a-post');
    memSetFeedItems('saved', [post], {
      hasMore: false,
      totalCount: 1,
      lastUpdated: Date.now(),
    });

    memClearAll();

    expect(memGetPostById(post.id)).toBeNull();
    expect(memGetAllFeedItems('saved')).toEqual([]);
    expect(memGetFeedKeysForPost(post.id)).toEqual([]);
  });
});
