import { PostVisibility } from '@mention/shared-types/post';
import type { FeedItem } from '@/db';
import { usePostsStore } from '../postsStore';

/**
 * A single-post READ is shared, not aborted.
 *
 * `getPostById` and `revalidatePostById` both key `pendingRequests` on
 * `post:<id>` and both abort whatever they find there. For a revalidation that
 * is right — it is a deliberate cache-buster. For two plain reads it is not:
 * they are the same question asked twice moments apart (the press-in prefetch,
 * then the detail screen's own mount), and the second used to cancel the first,
 * so the prefetch bought a cancelled request and no saved latency at all.
 *
 * The control case is what makes the shared-read case mean something: "one
 * request" is also what a map that collapsed EVERY read into one would report.
 */

const mockPosts = new Map<string, FeedItem>();
const mockGetPostById = jest.fn<Promise<FeedItem>, [string, AbortSignal | undefined]>();

jest.mock('@/db', () => ({
  upsertPost: (post: FeedItem) => {
    if (post.id) mockPosts.set(post.id, post);
  },
  upsertPosts: (posts: FeedItem[]) => {
    for (const post of posts) if (post.id) mockPosts.set(post.id, post);
  },
  getPostById: (postId: string) => mockPosts.get(postId) ?? null,
  updatePost: () => null,
  deletePost: (postId: string) => {
    mockPosts.delete(postId);
  },
  pruneOldPosts: jest.fn(),
  setFeedItems: jest.fn(),
  appendFeedItems: jest.fn(),
  getAllFeedItems: () => [],
  getFeedMeta: () => null,
  clearFeed: jest.fn(),
  addFeedItemAtStart: jest.fn(),
  getFeedKeysForPost: () => [],
  removePostFromAllFeeds: jest.fn(),
  removeFeedItem: jest.fn(),
  buildFeedKey: (type: string, userId?: string) => (userId ? `user:${userId}:${type}` : type),
  getDb: () => null,
  rowToFeedItem: (row: FeedItem) => row,
  clearAllCachedData: () => {
    mockPosts.clear();
  },
}));

jest.mock('@/services/feedService', () => ({
  feedService: {
    getPostById: (postId: string, signal?: AbortSignal) => mockGetPostById(postId, signal),
  },
}));
jest.mock('@/services/echoGuard', () => ({ markLocalAction: jest.fn() }));
jest.mock('@/stores/engagementInvalidation', () => ({ invalidateEngagementLists: jest.fn() }));
jest.mock('@/lib/precacheActorsFromPosts', () => ({ precacheActorsFromPosts: jest.fn() }));
jest.mock('@/stores/feedScrollStore', () => ({
  publishNewLocalPost: jest.fn(),
  publishRemovedLocalPost: jest.fn(),
}));
jest.mock('@oxyhq/core/logger', () => ({
  ...jest.requireActual('@oxyhq/core/logger'),
  createLogger: () => ({ debug: jest.fn(), error: jest.fn(), warn: jest.fn(), info: jest.fn() }),
}));

const makePost = (id: string): FeedItem => ({
  id,
  user: { id: `user-${id}`, username: id, name: { displayName: id } },
  authors: [],
  content: { text: id },
  attachments: {},
  metadata: {
    visibility: PostVisibility.PUBLIC,
    createdAt: '2026-08-01T10:00:00.000Z',
    updatedAt: '2026-08-01T10:00:00.000Z',
  },
  engagement: { likes: 0, downvotes: 0, boosts: 0, replies: 0 },
  viewerState: {
    isOwner: false,
    isCollaborator: false,
    isLiked: false,
    isDownvoted: false,
    isBoosted: false,
    isSaved: false,
  },
  permissions: { canReply: true, canDelete: false, canPin: false, canViewSources: false },
});

/** A request the test releases by hand, so two callers are provably concurrent. */
function deferred(id: string) {
  let release!: () => void;
  let fail!: (error: Error) => void;
  const promise = new Promise<FeedItem>((resolve, reject) => {
    release = () => resolve(makePost(id));
    fail = reject;
  });
  return { promise, release, fail };
}

describe('postsStore single-post reads', () => {
  beforeEach(() => {
    mockPosts.clear();
    mockGetPostById.mockReset();
    usePostsStore.getState().resetViewerState({ clearCachedData: true });
  });

  it('issues one request when the same post is read twice while in flight', async () => {
    const request = deferred('post-1');
    mockGetPostById.mockReturnValue(request.promise);

    const first = usePostsStore.getState().getPostById('post-1');
    const second = usePostsStore.getState().getPostById('post-1');

    request.release();
    const [a, b] = await Promise.all([first, second]);

    expect(mockGetPostById).toHaveBeenCalledTimes(1);
    expect(a?.id).toBe('post-1');
    expect(b).toBe(a);
  });

  it('still issues one request per distinct post', async () => {
    // The control. Without it, the assertion above is equally satisfied by a
    // map keyed on nothing, which would answer every read with one post.
    const one = deferred('post-1');
    const two = deferred('post-2');
    mockGetPostById.mockImplementation((postId) =>
      postId === 'post-1' ? one.promise : two.promise,
    );

    const first = usePostsStore.getState().getPostById('post-1');
    const second = usePostsStore.getState().getPostById('post-2');

    one.release();
    two.release();
    const [a, b] = await Promise.all([first, second]);

    expect(mockGetPostById).toHaveBeenCalledTimes(2);
    expect(a?.id).toBe('post-1');
    expect(b?.id).toBe('post-2');
  });

  it('releases the shared read once it settles', async () => {
    const request = deferred('post-1');
    mockGetPostById.mockReturnValue(request.promise);
    request.release();
    await usePostsStore.getState().getPostById('post-1');

    // Evict it so the next call cannot be answered from the cache instead.
    mockPosts.clear();
    const again = deferred('post-1');
    mockGetPostById.mockReturnValue(again.promise);
    again.release();
    await usePostsStore.getState().getPostById('post-1');

    expect(mockGetPostById).toHaveBeenCalledTimes(2);
  });

  it('does not retain a failed read', async () => {
    // A read that rejected must not become the answer to every later read of
    // that post — the failure mode that turns one network blip into a post that
    // can never be opened again this session.
    const failing = deferred('post-1');
    mockGetPostById.mockReturnValue(failing.promise);
    const rejected = usePostsStore.getState().getPostById('post-1');
    failing.fail(new Error('network down'));
    await expect(rejected).rejects.toThrow('network down');

    const recovered = deferred('post-1');
    mockGetPostById.mockReturnValue(recovered.promise);
    recovered.release();

    await expect(usePostsStore.getState().getPostById('post-1')).resolves.toMatchObject({
      id: 'post-1',
    });
    expect(mockGetPostById).toHaveBeenCalledTimes(2);
  });

  it('does not hand a previous viewer’s in-flight read to the next viewer', async () => {
    const request = deferred('post-1');
    mockGetPostById.mockReturnValue(request.promise);
    const beforeSwitch = usePostsStore.getState().getPostById('post-1');

    // The in-flight read is epoch-guarded to resolve `null`, so a joiner after
    // the switch would read "post not found" rather than read it fresh.
    usePostsStore.getState().resetViewerState({ clearCachedData: true });

    const afterSwitch = deferred('post-1');
    mockGetPostById.mockReturnValue(afterSwitch.promise);
    const readAgain = usePostsStore.getState().getPostById('post-1');

    request.release();
    afterSwitch.release();

    expect(await beforeSwitch).toBeNull();
    expect(await readAgain).toMatchObject({ id: 'post-1' });
    expect(mockGetPostById).toHaveBeenCalledTimes(2);
  });
});
