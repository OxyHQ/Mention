import { setActiveStore, Store } from '@oxy.so/bloom-data';
import type { FeedItem } from '@/db/schema';
import { Feed, feedKey, parseFeedKey, publishNewLocalPost } from '../feeds';
import { Post } from '../posts';

// Posts refer to the Oxy SDK's `User`; the real one, without the SDK's UI barrel.
jest.mock('@oxy.so/services/ui/client', () => jest.requireActual('@/test-support/oxyUsers'));

const post = (id: string, author = 'viewer') =>
  ({ id, user: { id: author }, engagement: {}, viewerState: {} }) as unknown as FeedItem;

const held = (key: string, ids: string[], postIds: string[][] = []) =>
  Feed.set(key, () => ({
    ids,
    extra: {
      pending: false,
      slices: postIds.map((items, index) => ({
        _sliceKey: `s${index}`,
        isIncompleteThread: false,
        items: items.map((postId) => ({
          postId,
          isThreadParent: false,
          isThreadChild: false,
          isThreadLastChild: false,
        })),
      })),
    },
    next: undefined,
    hasMore: false,
    visited: [],
    updatedAt: 1,
    origin: 'network',
  }));

beforeEach(() => setActiveStore(new Store()));

describe('feed keys', () => {
  it('name a feed by type, profile and normalised filters, never by viewer', () => {
    const key = feedKey({ type: 'replies', filters: { postId: 'p1' } });
    expect(parseFeedKey(key)).toEqual({
      type: 'replies',
      userId: undefined,
      filters: { postId: 'p1' },
    });
    expect(feedKey({ type: 'posts', userId: 'a', viewerId: 'v1' } as never)).toBe(
      feedKey({ type: 'posts', userId: 'a', viewerId: 'v2' } as never),
    );
    expect(feedKey({ type: 'hashtag', filters: {} })).toBe(feedKey({ type: 'hashtag' }));
  });
});

describe('feed lists', () => {
  it('drop a removed post from their ids and from the slices that carried it', () => {
    Post.put([post('a'), post('b')]);
    const key = feedKey({ type: 'for_you' });
    held(key, ['a', 'b'], [['a'], ['b']]);
    Post.remove('a');
    expect(Feed.get(key)?.ids).toEqual(['b']);
    expect(Feed.get(key)?.extra?.slices?.map((slice) => slice.items.map((i) => i.postId))).toEqual([
      ['b'],
    ]);
  });

  it('put the viewer’s new post on the home feeds and their own profile, once', () => {
    const home = feedKey({ type: 'for_you' });
    const own = feedKey({ type: 'posts', userId: 'viewer' });
    const other = feedKey({ type: 'posts', userId: 'someone' });
    const scoped = feedKey({ type: 'replies', filters: { postId: 'x' } });
    for (const key of [home, own, other, scoped]) held(key, ['old']);
    publishNewLocalPost(post('new'));
    publishNewLocalPost(post('new'));
    expect(Feed.get(home)?.ids).toEqual(['new', 'old']);
    expect(Feed.get(own)?.ids).toEqual(['new', 'old']);
    expect(Feed.get(other)?.ids).toEqual(['old']);
    expect(Feed.get(scoped)?.ids).toEqual(['old']);
    expect(Post.has('new')).toBe(true);
  });
});
