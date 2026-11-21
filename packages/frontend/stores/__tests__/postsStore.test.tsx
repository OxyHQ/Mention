import TestRenderer, { act } from 'react-test-renderer';
import { setActiveStore, Store } from '@oxy.so/bloom-data';
import { PostVisibility } from '@mention/shared-types/post';
import type { FeedItem } from '@/db/schema';
import { Feed, feedKey, prependBroadcastPosts } from '@/data/feeds';
import { getPost, Post } from '@/data/posts';
import { usePostInteractions } from '@/components/Feed/postInteractions';
import {
  applyServerViewCounts,
  usePostSelector,
  usePostsStore,
  useViewCountSelector,
} from '../postsStore';

/**
 * One copy of each post (`data/posts`), read field by field.
 *
 * A post the app holds is one record: a feed row, the detail screen, a quote
 * card and a boosted original all read it, and every write (a page, a like, a
 * realtime count, the post menu through `postsStore`) lands on it. A view
 * re-renders when a field it read changed and at no other time.
 */

const mockFeedService = {
  voteItem: jest.fn(),
  removeVote: jest.fn(),
  saveItem: jest.fn(),
  unsaveItem: jest.fn(),
  getPostById: jest.fn(),
};

jest.mock('@/services/feedService', () => ({
  feedService: {
    voteItem: (...args: unknown[]) => mockFeedService.voteItem(...args),
    removeVote: (...args: unknown[]) => mockFeedService.removeVote(...args),
    saveItem: (...args: unknown[]) => mockFeedService.saveItem(...args),
    unsaveItem: (...args: unknown[]) => mockFeedService.unsaveItem(...args),
    getPostById: (...args: unknown[]) => mockFeedService.getPostById(...args),
  },
}));
jest.mock('@/hooks/usePostShare', () => ({ sharePost: jest.fn() }));
jest.mock('@/services/echoGuard', () => ({ markLocalAction: jest.fn() }));
jest.mock('@/stores/engagementInvalidation', () => ({ invalidateEngagementLists: jest.fn() }));
jest.mock('@/stores/profileCountsInvalidation', () => ({ invalidateProfileCounts: jest.fn() }));
// Posts refer to the Oxy SDK's `User`; the real one, without the SDK's UI barrel.
jest.mock('@oxy.so/services/ui/client', () => jest.requireActual('@/test-support/oxyUsers'));

const makePost = (id: string, overrides: Partial<FeedItem> = {}): FeedItem => ({
  id,
  user: { id: `user-${id}`, username: `user-${id}`, name: { displayName: id } },
  authors: [],
  content: { text: id },
  attachments: {},
  documents: [],
  viewerState: {
    isOwner: false,
    isCollaborator: false,
    isLiked: false,
    isDownvoted: false,
    isBoosted: false,
    isSaved: false,
  },
  permissions: { canReply: true, canDelete: false, canPin: false, canViewSources: false },
  engagement: {
    likes: 0,
    downvotes: 0,
    boosts: 0,
    replies: 0,
    saves: 0,
    views: null,
    impressions: null,
  },
  metadata: {
    visibility: PostVisibility.PUBLIC,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
  ...overrides,
});

const seed = (post: FeedItem) => act(() => usePostsStore.getState().cachePosts([post]));

function Probe<T>({ read, onRender }: { read: () => T; onRender: (value: T) => void }) {
  onRender(read());
  return null;
}

function mount<T>(read: () => T) {
  const renders = jest.fn<void, [T]>();
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(<Probe read={read} onRender={renders} />);
  });
  renders.mockClear();
  return { renders, unmount: () => act(() => renderer.unmount()) };
}

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  jest.clearAllMocks();
  setActiveStore(new Store());
});

describe('one copy of each post', () => {
  it('stores a quoted or boosted post once, and a like on it reaches the post that embeds it', () => {
    const original = makePost('original');
    seed(
      makePost('boost', {
        content: { text: '' },
        boost: { actor: makePost('booster').user, originalPost: original },
      }),
    );
    seed(makePost('quote', { quotedPost: original }));

    act(() => void Post.merge('original', { engagement: { likes: 9 } }));

    expect(getPost('boost')?.boost?.originalPost?.engagement.likes).toBe(9);
    expect(getPost('quote')?.quotedPost?.engagement.likes).toBe(9);
  });

  it('never lets a boost that lost its original replace one that has it', () => {
    seed(makePost('boost', { boost: { actor: makePost('a').user, originalPost: makePost('o') } }));
    seed(makePost('boost', { boost: { actor: makePost('a').user, originalPost: null } }));
    expect(getPost('boost')?.boost?.originalPost?.id).toBe('o');
  });

  // The realtime broadcast is hydrated for NO viewer. Writing it over the
  // viewer's own post used to demote it to a stranger's: the ⋯ menu lost its
  // owner actions and the row lost Insights (#1140).
  it('a realtime post keeps the viewer state of the copy already held', () => {
    seed(
      makePost('own-post', {
        viewerState: { ...makePost('x').viewerState, isOwner: true, isLiked: true },
        permissions: { canReply: true, canDelete: true, canPin: true, canViewSources: false },
      }),
    );
    act(() =>
      Feed.set(feedKey({ type: 'for_you' }), () => ({
        ids: [],
        extra: { pending: false },
        next: undefined,
        hasMore: false,
        visited: [],
        updatedAt: 1,
        origin: 'network',
      })),
    );

    act(() =>
      prependBroadcastPosts('for_you', [
        makePost('own-post', { content: { text: 'edited body' } }) as never,
      ]),
    );

    const stored = getPost('own-post');
    expect(stored?.viewerState.isOwner).toBe(true);
    expect(stored?.viewerState.isLiked).toBe(true);
    expect(stored?.permissions?.canDelete).toBe(true);
    expect(stored?.content.text).toBe('edited body');
    expect(Feed.get(feedKey({ type: 'for_you' }))?.ids[0]).toBe('own-post');
  });

  it('removes a deleted post with the boosts and quotes of it, from every feed', () => {
    seed(makePost('gone'));
    seed(
      makePost('boost-of-it', {
        boost: { actor: makePost('a').user, originalPost: makePost('gone') },
      }),
    );
    act(() =>
      Feed.set(feedKey({ type: 'for_you' }), () => ({
        ids: ['gone', 'boost-of-it'],
        extra: { pending: false },
        next: undefined,
        hasMore: false,
        visited: [],
        updatedAt: 1,
        origin: 'network',
      })),
    );
    act(() => usePostsStore.getState().removePostEverywhere('gone'));
    expect(getPost('gone')).toBeNull();
    expect(getPost('boost-of-it')).toBeNull();
    expect(Feed.get(feedKey({ type: 'for_you' }))?.ids).toEqual([]);
  });
});

describe('field-level reads', () => {
  it('a like re-renders what reads the counts and the heart, not what reads the body', async () => {
    seed(makePost('p'));
    mockFeedService.voteItem.mockResolvedValue({
      success: true,
      data: { likesCount: 1, liked: true },
    });
    const actions = mount(() => {
      const post = usePostSelector('p');
      return `${post?.engagement.likes}:${post?.viewerState.isLiked}`;
    });
    const body = mount(() => usePostSelector('p')?.content.text);

    await act(async () => {
      await usePostsStore.getState().likePost({ postId: 'p', type: 'post' });
    });

    expect(actions.renders.mock.calls.map(([value]) => value)).toEqual(['1:true']);
    expect(body.renders).not.toHaveBeenCalled();
    actions.unmount();
    body.unmount();
  });

  it('a failed like rolls back to the server copy as it now stands', async () => {
    seed(makePost('p', { engagement: { ...makePost('p').engagement, likes: 5 } }));
    let fail!: (error: Error) => void;
    mockFeedService.voteItem.mockReturnValue(new Promise((_resolve, reject) => (fail = reject)));
    const like = usePostsStore.getState().likePost({ postId: 'p', type: 'post' });
    expect(getPost('p')?.engagement.likes).toBe(6);
    // Somebody else's like arrives in the meantime.
    act(() => void Post.merge('p', { engagement: { likes: 7 } }));
    expect(getPost('p')?.engagement.likes).toBe(6);
    fail(new Error('offline'));
    await expect(like).rejects.toThrow('offline');
    expect(getPost('p')?.engagement.likes).toBe(7);
    expect(getPost('p')?.viewerState.isLiked).toBe(false);
  });

  it('a second tap on like while the first is in flight changes nothing', async () => {
    seed(makePost('p'));
    let answer!: (value: unknown) => void;
    mockFeedService.voteItem.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    const first = usePostsStore.getState().likePost({ postId: 'p', type: 'post' });
    await usePostsStore.getState().unlikePost({ postId: 'p', type: 'post' });
    expect(mockFeedService.removeVote).not.toHaveBeenCalled();
    expect(getPost('p')?.engagement.likes).toBe(1);
    answer({ success: true, data: {} });
    await first;
    expect(getPost('p')?.engagement.likes).toBe(1);
  });
});

describe('view counts', () => {
  it('a server total repaints what draws the count and leaves the row alone', () => {
    seed(makePost('viewed', { engagement: { ...makePost('v').engagement, views: 3 } }));
    const count = mount(() => useViewCountSelector('viewed'));
    const row = mount(() => {
      const post = usePostSelector('viewed');
      return `${post?.engagement.views}:${post?.engagement.likes}`;
    });

    act(() => applyServerViewCounts({ viewed: 42 }));

    expect(count.renders.mock.calls.map(([value]) => value)).toEqual([42]);
    expect(row.renders).not.toHaveBeenCalled();
    count.unmount();
    row.unmount();
  });

  it('a rewritten post carries its count to what draws it', () => {
    seed(makePost('rewritten', { engagement: { ...makePost('v').engagement, views: 3 } }));
    const count = mount(() => useViewCountSelector('rewritten'));
    seed(makePost('rewritten', { engagement: { ...makePost('v').engagement, views: 99 } }));
    expect(count.renders.mock.calls.at(-1)?.[0]).toBe(99);
    count.unmount();
  });

  it('reports a post not held as undefined, and a hidden count as null', () => {
    seed(makePost('counted'));
    const unheld = mount(() => useViewCountSelector('not-held'));
    act(() => applyServerViewCounts({ 'not-held': 42 }));
    expect(unheld.renders).not.toHaveBeenCalled();
    const hidden = mount(() => useViewCountSelector('counted'));
    act(() => applyServerViewCounts({ counted: Number.NaN }));
    expect(hidden.renders).not.toHaveBeenCalled();
    unheld.unmount();
    hidden.unmount();
  });

  it('does not repaint when the count already matches', () => {
    seed(makePost('same', { engagement: { ...makePost('v').engagement, views: 42 } }));
    const count = mount(() => useViewCountSelector('same'));
    act(() => applyServerViewCounts({ same: 42 }));
    expect(count.renders).not.toHaveBeenCalled();
    count.unmount();
  });
});

describe('save / unsave reconcile', () => {
  it('converges a stale base to the server count instead of drifting from it', async () => {
    seed(makePost('stale', { engagement: { ...makePost('s').engagement, saves: 5 } }));
    mockFeedService.saveItem.mockResolvedValue({ success: true, data: { savesCount: 101 } });
    await act(async () => {
      await usePostsStore.getState().savePost({ postId: 'stale' });
    });
    expect(getPost('stale')?.engagement.saves).toBe(101);
    expect(getPost('stale')?.viewerState.isSaved).toBe(true);
  });

  it('converges on unsave too', async () => {
    seed(
      makePost('stale', {
        engagement: { ...makePost('s').engagement, saves: 5 },
        viewerState: { ...makePost('s').viewerState, isSaved: true },
      }),
    );
    mockFeedService.unsaveItem.mockResolvedValue({ success: true, data: { savesCount: 100 } });
    await act(async () => {
      await usePostsStore.getState().unsavePost({ postId: 'stale' });
    });
    expect(getPost('stale')?.engagement.saves).toBe(100);
    expect(getPost('stale')?.viewerState.isSaved).toBe(false);
  });

  it('acquires a count the optimistic path could never have produced', async () => {
    seed(makePost('already', { engagement: { ...makePost('s').engagement, saves: null } }));
    mockFeedService.saveItem.mockResolvedValue({ success: true, data: { savesCount: 12 } });
    await act(async () => {
      await usePostsStore.getState().savePost({ postId: 'already' });
    });
    expect(getPost('already')?.engagement.saves).toBe(12);
  });

  it('keeps the optimistic state when the answer carries no count', async () => {
    seed(makePost('no-count', { engagement: { ...makePost('s').engagement, saves: 5 } }));
    mockFeedService.saveItem.mockResolvedValue({ success: true, data: { message: 'ok' } });
    await act(async () => {
      await usePostsStore.getState().savePost({ postId: 'no-count' });
    });
    expect(getPost('no-count')?.engagement.saves).toBe(6);
    expect(getPost('no-count')?.viewerState.isSaved).toBe(true);
  });
});

describe('row commands (#1103)', () => {
  function RowProbe({ postId, onRender }: { postId: string; onRender: () => void }) {
    // What a row draws of the save: its flag.
    void usePostSelector(postId)?.viewerState.isSaved;
    usePostInteractions();
    onRender();
    return null;
  }

  it('saving post A does not re-render the row for post B, nor any write to another post', async () => {
    seed(makePost('a'));
    seed(makePost('b'));
    mockFeedService.saveItem.mockResolvedValue({ success: true, data: { message: 'ok' } });
    const rendersA = jest.fn();
    const rendersB = jest.fn();
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        <>
          <RowProbe postId="a" onRender={rendersA} />
          <RowProbe postId="b" onRender={rendersB} />
        </>,
      );
    });
    const beforeA = rendersA.mock.calls.length;
    const beforeB = rendersB.mock.calls.length;

    await act(async () => {
      await usePostsStore.getState().savePost({ postId: 'a' });
    });
    act(() => void seed(makePost('unrelated')));

    expect(rendersA.mock.calls.length).toBeGreaterThan(beforeA);
    expect(rendersB).toHaveBeenCalledTimes(beforeB);
    act(() => renderer.unmount());
  });
});
