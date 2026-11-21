import { PostVisibility } from '@mention/shared-types/post';
import { setActiveStore, Store } from '@oxy.so/bloom-data';
import { Post } from '@/data/posts';
import type { FeedItem } from '@/db/schema';
import { usePostsStore } from '../postsStore';

/**
 * A single-post READ is shared, not aborted.
 *
 * `getPostById` joins a read of the same post in flight; `revalidatePostById`
 * supersedes it. For a revalidation that is right — it is a deliberate
 * cache-buster. For two plain reads it is not:
 * they are the same question asked twice moments apart (the press-in prefetch,
 * then the detail screen's own mount), and the second used to cancel the first,
 * so the prefetch bought a cancelled request and no saved latency at all.
 *
 * The control case is what makes the shared-read case mean something: "one
 * request" is also what a map that collapsed EVERY read into one would report.
 */

const mockGetPostById = jest.fn<Promise<FeedItem>, [string, AbortSignal | undefined]>();
const mockGetPostsByIds = jest.fn<Promise<FeedItem[]>, [readonly string[]]>();

jest.mock('@/services/feedService', () => ({
  feedService: {
    getPostById: (postId: string, signal?: AbortSignal) => mockGetPostById(postId, signal),
    getPostsByIds: (ids: readonly string[]) => mockGetPostsByIds(ids),
  },
}));
jest.mock('@/services/echoGuard', () => ({ markLocalAction: jest.fn() }));
jest.mock('@/stores/engagementInvalidation', () => ({ invalidateEngagementLists: jest.fn() }));
// Posts refer to the Oxy SDK's `User`; the real one, without the SDK's UI barrel.
jest.mock('@oxy.so/services/ui/client', () => jest.requireActual('@/test-support/oxyUsers'));
jest.mock('@oxy.so/core/logger', () => ({
  ...jest.requireActual('@oxy.so/core/logger'),
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

/** Opens the next account's store, as `AccountSwitchReset` does on a switch. */
function switchAccount(): void {
  void store.close();
  store = new Store();
  setActiveStore(store);
}
let store = new Store();

describe('postsStore single-post reads', () => {
  beforeEach(() => {
    mockGetPostById.mockReset();
    switchAccount();
  });

  it.each([403, 404])('evicts every embedded copy when revalidation returns %s', async (status) => {
    const privatePost = makePost('private');
    const quote = { ...makePost('quote'), quotedPost: privatePost };
    const boost = { ...makePost('boost'), originalPost: quote };
    Post.put([privatePost, quote, boost]);
    mockGetPostById.mockRejectedValueOnce(Object.assign(new Error('unavailable'), { status }));
    expect(await usePostsStore.getState().revalidatePostById('private')).toBeNull();
    expect(Post.ids()).toEqual([]);
  });

  it('preserves the cache on transport failures for callers with known adult access', async () => {
    Post.put(makePost('cached'));
    mockGetPostById.mockRejectedValueOnce(
      Object.assign(new Error('authority unavailable'), { status: 503 }),
    );
    expect(await usePostsStore.getState().revalidatePostById('cached')).toBeNull();
    expect(Post.has('cached')).toBe(true);
  });

  it('does not evict the new viewer cache when the previous viewer receives a denial', async () => {
    const request = deferred('cached');
    mockGetPostById.mockReturnValueOnce(request.promise);
    const beforeSwitch = usePostsStore.getState().revalidatePostById('cached');
    switchAccount();
    Post.put(makePost('cached'));
    request.fail(Object.assign(new Error('revoked'), { status: 403 }));
    await beforeSwitch;
    expect(Post.has('cached')).toBe(true);
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
    Post.remove('post-1');
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
    // The disk copy is asked first; then the read is on the wire.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mockGetPostById).toHaveBeenCalledTimes(1);

    // The in-flight read belongs to the previous account's (closed) store, so
    // it resolves `null`; the next account reads the post fresh.
    switchAccount();

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

describe('postsStore batch reads', () => {
  beforeEach(() => {
    mockGetPostsByIds.mockReset();
    switchAccount();
  });

  it('reads only the uncached posts, in one request, and keeps the order asked for', async () => {
    Post.put(makePost('cached'));
    // `hidden` is refused by the server, so it is simply absent.
    mockGetPostsByIds.mockResolvedValue([makePost('fresh')]);

    const posts = await usePostsStore.getState().getPostsByIds(['fresh', 'cached', 'hidden']);

    expect(mockGetPostsByIds).toHaveBeenCalledTimes(1);
    expect(mockGetPostsByIds).toHaveBeenCalledWith(['fresh', 'hidden']);
    expect(posts.map((post) => post.id)).toEqual(['fresh', 'cached']);
    expect(Post.has('fresh')).toBe(true);
  });

  it('asks nothing when every post is cached', async () => {
    Post.put(makePost('a'));
    expect((await usePostsStore.getState().getPostsByIds(['a'])).map((post) => post.id)).toEqual([
      'a',
    ]);
    expect(mockGetPostsByIds).not.toHaveBeenCalled();
  });
});
