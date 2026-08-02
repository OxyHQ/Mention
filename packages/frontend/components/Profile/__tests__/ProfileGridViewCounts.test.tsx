import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { PostVisibility } from '@mention/shared-types/post';
import type { FeedItem } from '@/db';
import { applyServerViewCounts, usePostsStore, useUserFeedSelector } from '@/stores/postsStore';
import LiveVideoPosterCell from '../LiveVideoPosterCell';

/**
 * The profile grids' play count, end to end: a real `postsStore` write must
 * repaint a real grid cell.
 *
 * This is the half of the view-count fix that the server round trip does not
 * cover. The grids read their entries out of a FEED snapshot, and an engagement
 * write deliberately wakes only the changed POST's subscribers — so before
 * `LiveVideoPosterCell` the authoritative count reached SQLite and stopped
 * there. Measured at the time: a feed-snapshot consumer got ZERO re-renders from
 * such a write while a `usePostSelector` consumer got one.
 *
 * So the assertions here are deliberately about the RENDERED LABEL after a real
 * `applyServerViewCounts` call, not about a prop being threaded: the store, the
 * subscription and the cell all participate, and the feed snapshot is checked to
 * be untouched so a passing test cannot be crediting a feed-level refresh.
 *
 * Only SQLite and the network-facing services are mocked (neither loads under
 * jest); the store and the component are real.
 */

const mockPosts = new Map<string, FeedItem>();
const mockFeedIds = new Map<string, string[]>();

jest.mock('@/db', () => ({
  upsertPost: (post: FeedItem) => {
    if (post.id) mockPosts.set(post.id, post);
  },
  upsertPosts: (posts: FeedItem[]) => {
    for (const post of posts) if (post.id) mockPosts.set(post.id, post);
  },
  getPostById: (postId: string) => mockPosts.get(postId) ?? null,
  updatePost: (
    postId: string,
    updater: (previous: FeedItem) => FeedItem | null | undefined
  ) => {
    const previous = mockPosts.get(postId);
    if (!previous) return null;
    const next = updater(previous);
    if (!next) return null;
    mockPosts.set(postId, next);
    return next;
  },
  deletePost: (postId: string) => mockPosts.delete(postId),
  pruneOldPosts: jest.fn(),
  setFeedItems: jest.fn(),
  appendFeedItems: jest.fn(),
  getAllFeedItems: (feedKey: string) =>
    (mockFeedIds.get(feedKey) ?? [])
      .map((postId) => mockPosts.get(postId))
      .filter((post): post is FeedItem => Boolean(post)),
  getFeedMeta: () => null,
  clearFeed: jest.fn(),
  addFeedItemAtStart: (feedKey: string, postId: string) => {
    const current = mockFeedIds.get(feedKey) ?? [];
    if (!current.includes(postId)) mockFeedIds.set(feedKey, [postId, ...current]);
  },
  getFeedKeysForPost: () => [],
  removePostFromAllFeeds: jest.fn(),
  removeFeedItem: jest.fn(),
  buildFeedKey: (type: string, userId?: string) =>
    userId ? `user:${userId}:${type}` : type,
  clearAllCachedData: jest.fn(),
}));

jest.mock('@/services/feedService', () => ({ feedService: {} }));
jest.mock('@/services/echoGuard', () => ({ markLocalAction: jest.fn() }));
jest.mock('@/lib/precacheActorsFromPosts', () => ({
  precacheActorsFromPosts: jest.fn(),
}));
jest.mock('@/stores/feedScrollStore', () => ({
  publishNewLocalPost: jest.fn(),
  publishRemovedLocalPost: jest.fn(),
}));
jest.mock('@/stores/engagementInvalidation', () => ({
  invalidateEngagementLists: jest.fn(),
}));
jest.mock('@oxyhq/core/logger', () => ({
  ...jest.requireActual('@oxyhq/core/logger'),
  createLogger: () => ({
    debug: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
  }),
}));

/**
 * Stands in for the grids' own data source (`useProfileMediaFeed` →
 * `useUserFeedSelector`). Present as a CONTROL: it is what the entries are built
 * from, and it must stay non-reactive to an engagement write.
 */
function FeedSnapshotProbe({
  userId,
  onRender,
}: {
  userId: string;
  onRender: (items: FeedItem[]) => void;
}) {
  onRender(useUserFeedSelector(userId, 'posts').items);
  return null;
}

const CELL = { posterUri: 'https://cdn.example/poster.jpg', size: 120, placeholderColor: '#888' };

const makePost = (id: string, views: number | null): FeedItem => ({
  id,
  user: { id: `user-${id}`, username: `user-${id}`, name: { displayName: id } },
  authors: [],
  content: { text: id },
  attachments: {},
  linkPreviews: [],
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
    views,
    impressions: null,
  },
  metadata: {
    visibility: PostVisibility.PUBLIC,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
});

/** Mount awaits an async act: `Ionicons` resolves its font in a promise. */
async function mount(element: React.ReactElement) {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(element);
  });
  return renderer;
}

/**
 * The strings the cell paints as LABELS — the same discriminator
 * `VideoPosterCell.test.tsx` uses: an icon glyph is also a host `Text`, and it is
 * the only one without a `className`.
 */
function labels(renderer: TestRenderer.ReactTestRenderer): string[] {
  return renderer.root
    .findAll((node) => String(node.type) === 'Text', { deep: true })
    .filter((node) => typeof (node.props as { className?: unknown }).className === 'string')
    .flatMap((node) => node.children.filter((child): child is string => typeof child === 'string'));
}

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  mockPosts.clear();
  mockFeedIds.clear();
});

describe('profile grid cells repaint from a server view count', () => {
  /**
   * The measurement this whole change exists for, with its own control.
   *
   * Before `LiveVideoPosterCell` the feed-snapshot probe below was the ONLY
   * subscriber a grid had, and it read zero re-renders from this write — the
   * authoritative count reached SQLite and the screen never learned. It still
   * reads zero here, deliberately: the fix does not make feed snapshots reactive
   * (that would put a key lookup plus a full feed re-read on every like and save
   * to serve a number that moves rarely), it gives the CELL its own subscription.
   *
   * So the probe is the control in both directions — it proves the granular
   * design is intact, and it proves the repaint below cannot be credited to a
   * feed-level refresh.
   */
  it('repaints with the authoritative count, without the feed snapshot moving', async () => {
    const post = makePost('watched', 3);
    act(() => {
      usePostsStore.getState().addPostsToFeed([post], 'posts');
    });

    const feedRenders = jest.fn();
    let feedProbe!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      feedProbe = TestRenderer.create(
        <FeedSnapshotProbe userId="author" onRender={feedRenders} />
      );
    });

    const renderer = await mount(
      <LiveVideoPosterCell {...CELL} viewsPostId="watched" fallbackViews={3} />
    );
    expect(labels(renderer)).toEqual(['3']);
    feedRenders.mockClear();

    await act(async () => {
      applyServerViewCounts({ watched: 42 });
    });

    // The cell repainted...
    expect(labels(renderer)).toEqual(['42']);
    // ...and nothing at the feed level did.
    expect(feedRenders).not.toHaveBeenCalled();

    act(() => {
      renderer.unmount();
      feedProbe.unmount();
    });
  });

  it('keeps the fetch-time count when the post is not in the shared cache', async () => {
    // A grid whose posts never entered the store — the store row is the fresher
    // of the two ONLY when it exists, so with no row the entry's own number must
    // survive rather than the cell going blank.
    const renderer = await mount(
      <LiveVideoPosterCell {...CELL} viewsPostId="uncached" fallbackViews={1234} />
    );

    expect(labels(renderer)).toEqual(['1.2K']);

    act(() => renderer.unmount());
  });

  it('prefers a cached count of null over a stale fetch-time number', async () => {
    // `??` here would resurrect the entry's number for a post whose count is
    // genuinely absent. The entry was derived FROM the row, so the row wins.
    act(() => {
      usePostsStore.getState().cachePosts([makePost('hidden', null)]);
    });

    const renderer = await mount(
      <LiveVideoPosterCell {...CELL} viewsPostId="hidden" fallbackViews={99} />
    );

    expect(labels(renderer)).toEqual([]);

    act(() => renderer.unmount());
  });

  it('follows the post the count describes, not the post the cell opens', async () => {
    // The media grid's boost/quote case: the cell navigates to the outer post but
    // shows the ORIGINAL's video, so it must subscribe to the original. Both are
    // cached with different counts, so a cell wired to the wrong one is visible.
    act(() => {
      usePostsStore.getState().cachePosts([makePost('boost', 5), makePost('original', 500)]);
    });

    const renderer = await mount(
      <LiveVideoPosterCell {...CELL} viewsPostId="original" fallbackViews={500} />
    );
    expect(labels(renderer)).toEqual(['500']);

    await act(async () => {
      applyServerViewCounts({ original: 777 });
    });
    expect(labels(renderer)).toEqual(['777']);

    // A write to the post the cell merely LINKS to must not touch it.
    await act(async () => {
      applyServerViewCounts({ boost: 6 });
    });
    expect(labels(renderer)).toEqual(['777']);

    act(() => renderer.unmount());
  });

  it('ignores a write to an unrelated post', async () => {
    act(() => {
      usePostsStore.getState().cachePosts([makePost('mine', 3), makePost('theirs', 3)]);
    });

    const renderer = await mount(
      <LiveVideoPosterCell {...CELL} viewsPostId="mine" fallbackViews={3} />
    );

    await act(async () => {
      applyServerViewCounts({ theirs: 9999 });
    });

    expect(labels(renderer)).toEqual(['3']);

    act(() => renderer.unmount());
  });

  /**
   * Cardinality. A 3-column grid mounts a subscription per video cell, and the
   * web path renders inside document scroll (`scrollEnabled={false}`), so the
   * mounted count trends toward every loaded entry rather than a viewport's
   * worth — more than a virtualized feed mounts `PostItem`s.
   *
   * What makes that safe is not the count but the KEYING: listeners are held per
   * post id, so a write reaches only the ids it names. This pins the OUTPUT of
   * that at scale — one write, one cell moved, 59 untouched — which is what a
   * reader of the grid would notice going wrong. The per-subscriber render
   * accounting behind it belongs to the store and is pinned there
   * (`postsStoreGranularReactivity`, "updates only the changed post without
   * re-reading either feed").
   */
  it('moves exactly one cell out of many, however many are mounted', async () => {
    const cellCount = 60;
    const posts = Array.from({ length: cellCount }, (_, i) => makePost(`p${i}`, 1));
    act(() => {
      usePostsStore.getState().cachePosts(posts);
    });

    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <>
          {posts.map((_, index) => (
            <LiveVideoPosterCell
              key={index}
              {...CELL}
              viewsPostId={`p${index}`}
              fallbackViews={1}
            />
          ))}
        </>
      );
    });

    // Vacuity floor: without this a broken label traversal would report "no cell
    // moved" as a pass.
    expect(labels(renderer)).toHaveLength(cellCount);

    await act(async () => {
      applyServerViewCounts({ p7: 500 });
    });

    const after = labels(renderer);
    expect(after.filter((label) => label === '500')).toHaveLength(1);
    expect(after.filter((label) => label === '1')).toHaveLength(cellCount - 1);

    act(() => renderer.unmount());
  });

  it('still spells 0, null and absent identically once the count is live', async () => {
    // The pure cell's own contract (`0` on native after the SQLite round trip vs
    // `null` on web) must survive the subscription: the wrapper hands the value
    // through untouched rather than normalizing it.
    act(() => {
      usePostsStore.getState().cachePosts([makePost('zeroed', 0), makePost('nulled', null)]);
    });

    const zero = await mount(
      <LiveVideoPosterCell {...CELL} viewsPostId="zeroed" durationSec={42} />
    );
    const nulled = await mount(
      <LiveVideoPosterCell {...CELL} viewsPostId="nulled" durationSec={42} />
    );
    const absent = await mount(<LiveVideoPosterCell {...CELL} durationSec={42} />);

    expect(labels(zero)).toEqual(labels(nulled));
    expect(labels(nulled)).toEqual(labels(absent));
    expect(labels(absent)).toEqual(['0:42']);

    act(() => {
      zero.unmount();
      nulled.unmount();
      absent.unmount();
    });
  });
});
