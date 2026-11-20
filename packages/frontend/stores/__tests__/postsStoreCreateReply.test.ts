import { setActiveStore, Store } from '@oxy.so/bloom-data';
import { getPost, Post } from '@/data/posts';
import type { FeedItem } from '@/db/schema';
import type { HydratedPost } from '@mention/shared-types';
import { usePostsStore } from '../postsStore';

/**
 * A reply the server accepted reaches the thread it answers (OxyHQ/Mention#1140).
 *
 * `createReply` bumped the parent's count and returned nothing, so the thread's
 * replies list — a scoped feed no other write reaches — kept its empty state
 * until a pull-to-refresh. It now caches the hydrated reply the server returns
 * and publishes it for that list (`data/feeds` puts it on top), and a refused
 * reply publishes nothing.
 */

const mockCreateReply = jest.fn();
const mockPublishNewLocalReply = jest.fn();

jest.mock('@/services/feedService', () => ({
  feedService: {
    createReply: (...args: unknown[]) => mockCreateReply(...args),
  },
}));

jest.mock('@/services/echoGuard', () => ({ markLocalAction: jest.fn() }));
jest.mock('@/lib/precacheActorsFromPosts', () => ({ precacheActorsFromPosts: jest.fn() }));
jest.mock('@/data/feeds', () => ({
  publishNewLocalPost: jest.fn(),
  publishNewLocalReply: (...args: unknown[]) => mockPublishNewLocalReply(...args),
}));
jest.mock('@oxy.so/core/logger', () => ({
  ...jest.requireActual('@oxy.so/core/logger'),
  createLogger: () => ({ debug: jest.fn(), error: jest.fn(), warn: jest.fn(), info: jest.fn() }),
}));

const PARENT = 'parent-1';

function hydratedReply(): HydratedPost {
  return {
    id: 'reply-1',
    parentPostId: PARENT,
    user: { id: 'viewer' },
    content: { text: 'hello' },
    engagement: { likes: 0, replies: 0, boosts: 0, saves: 0, downvotes: 0 },
    viewerState: {
      isOwner: true,
      isLiked: false,
      isBoosted: false,
      isSaved: false,
      isDownvoted: false,
    },
    metadata: {},
    attachments: {},
    createdAt: '2026-09-25T12:00:00Z',
  } as unknown as HydratedPost;
}

describe('postsStore.createReply', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setActiveStore(new Store());
    Post.put({
      id: PARENT,
      engagement: { likes: 0, replies: 0, boosts: 0, saves: 0, downvotes: 0 },
    } as unknown as FeedItem);
  });

  it('caches the server’s reply, hands it to the thread, and returns it', async () => {
    mockCreateReply.mockResolvedValue({ success: true, reply: hydratedReply() });

    const reply = await usePostsStore
      .getState()
      .createReply({ postId: PARENT, content: { text: 'hello' } });

    expect(reply?.id).toBe('reply-1');
    expect(getPost('reply-1')?.parentPostId).toBe(PARENT);
    expect(mockPublishNewLocalReply).toHaveBeenCalledTimes(1);
    expect(mockPublishNewLocalReply.mock.calls[0][0]).toMatchObject({
      id: 'reply-1',
      parentPostId: PARENT,
    });
    expect(getPost(PARENT)?.engagement.replies).toBe(1);
  });

  it('publishes nothing when the server refuses the reply, and rolls the count back', async () => {
    mockCreateReply.mockResolvedValue({ success: false, reply: null });

    await expect(
      usePostsStore.getState().createReply({ postId: PARENT, content: { text: 'hello' } }),
    ).rejects.toThrow();

    expect(mockPublishNewLocalReply).not.toHaveBeenCalled();
    expect(getPost(PARENT)?.engagement.replies).toBe(0);
  });
});
