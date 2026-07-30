import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import type { FeedType } from '@mention/shared-types/feed';
import { PostVisibility } from '@mention/shared-types/post';
import type { FeedItem, FeedMetaData } from '@/db';
import {
  useFeedSelector,
  usePostSelector,
  usePostsStore,
  useUserFeedSelector,
} from '../postsStore';

const mockPosts = new Map<string, FeedItem>();
const mockFeedIds = new Map<string, string[]>();
const mockFeedMeta = new Map<string, FeedMetaData>();
const mockPostReadCounts = new Map<string, number>();
const mockPostWriteCounts = new Map<string, number>();
const mockFeedReadCounts = new Map<string, number>();
const mockClearAllCachedData = jest.fn(() => {
  mockPosts.clear();
  mockFeedIds.clear();
  mockFeedMeta.clear();
});
const mockFeedService = {
  getSavedPosts: jest.fn(),
  getUserFeed: jest.fn(),
  getPostById: jest.fn(),
};

const mockBuildFeedKey = (type: string, userId?: string) =>
  userId ? `user:${userId}:${type}` : type;

const mockResolvePostId = (post: FeedItem) => post.id;

const mockUpsertPost = (post: FeedItem) => {
  const id = mockResolvePostId(post);
  if (id) {
    mockPosts.set(id, post);
    mockPostWriteCounts.set(id, (mockPostWriteCounts.get(id) ?? 0) + 1);
  }
};

const mockUpsertPosts = (posts: FeedItem[]) => {
  for (const post of posts) mockUpsertPost(post);
};

jest.mock('@/db', () => ({
  upsertPost: (post: FeedItem) => mockUpsertPost(post),
  upsertPosts: (posts: FeedItem[]) => mockUpsertPosts(posts),
  getPostById: (postId: string) => {
    mockPostReadCounts.set(postId, (mockPostReadCounts.get(postId) ?? 0) + 1);
    return mockPosts.get(postId) ?? null;
  },
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
  deletePost: (postId: string) => {
    mockPosts.delete(postId);
  },
  pruneOldPosts: jest.fn(),
  setFeedItems: (feedKey: string, posts: FeedItem[], meta: FeedMetaData) => {
    mockUpsertPosts(posts);
    mockFeedIds.set(feedKey, posts.map(mockResolvePostId).filter(Boolean));
    mockFeedMeta.set(feedKey, meta);
  },
  appendFeedItems: (
    feedKey: string,
    posts: FeedItem[],
    meta: Partial<FeedMetaData>
  ) => {
    mockUpsertPosts(posts);
    const current = mockFeedIds.get(feedKey) ?? [];
    const next = [...current];
    for (const post of posts) {
      const id = mockResolvePostId(post);
      if (id && !next.includes(id)) next.push(id);
    }
    mockFeedIds.set(feedKey, next);
    const previousMeta = mockFeedMeta.get(feedKey);
    mockFeedMeta.set(feedKey, {
      hasMore: meta.hasMore ?? previousMeta?.hasMore ?? false,
      nextCursor: meta.nextCursor ?? previousMeta?.nextCursor,
      totalCount: meta.totalCount ?? previousMeta?.totalCount ?? next.length,
      lastUpdated: meta.lastUpdated ?? Date.now(),
      filters: meta.filters ?? previousMeta?.filters,
    });
  },
  getAllFeedItems: (feedKey: string) => {
    mockFeedReadCounts.set(feedKey, (mockFeedReadCounts.get(feedKey) ?? 0) + 1);
    return (mockFeedIds.get(feedKey) ?? [])
      .map((postId) => mockPosts.get(postId))
      .filter((post): post is FeedItem => Boolean(post));
  },
  getFeedMeta: (feedKey: string) => mockFeedMeta.get(feedKey) ?? null,
  clearFeed: (feedKey: string) => {
    mockFeedIds.delete(feedKey);
    mockFeedMeta.delete(feedKey);
  },
  addFeedItemAtStart: (feedKey: string, postId: string) => {
    const current = mockFeedIds.get(feedKey) ?? [];
    if (!current.includes(postId)) mockFeedIds.set(feedKey, [postId, ...current]);
  },
  getFeedKeysForPost: (postId: string) =>
    [...mockFeedIds.entries()]
      .filter(([, postIds]) => postIds.includes(postId))
      .map(([feedKey]) => feedKey),
  removePostFromAllFeeds: (postId: string) => {
    for (const [feedKey, postIds] of mockFeedIds) {
      if (postIds.includes(postId)) {
        mockFeedIds.set(feedKey, postIds.filter((id) => id !== postId));
      }
    }
  },
  removeFeedItem: (feedKey: string, postId: string) => {
    const current = mockFeedIds.get(feedKey) ?? [];
    mockFeedIds.set(feedKey, current.filter((id) => id !== postId));
  },
  buildFeedKey: (type: string, userId?: string) =>
    userId ? `user:${userId}:${type}` : type,
  getDb: () => null,
  rowToFeedItem: (row: FeedItem) => row,
  clearAllCachedData: () => mockClearAllCachedData(),
}));

jest.mock('@/services/feedService', () => ({
  feedService: {
    getSavedPosts: (...args: unknown[]) =>
      mockFeedService.getSavedPosts(...args),
    getUserFeed: (...args: unknown[]) =>
      mockFeedService.getUserFeed(...args),
    getPostById: (...args: unknown[]) =>
      mockFeedService.getPostById(...args),
  },
}));
jest.mock('@/services/echoGuard', () => ({ markLocalAction: jest.fn() }));
jest.mock('@/lib/precacheActorsFromPosts', () => ({
  precacheActorsFromPosts: jest.fn(),
}));
jest.mock('@/stores/feedScrollStore', () => ({
  publishNewLocalPost: jest.fn(),
  publishRemovedLocalPost: jest.fn(),
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

const makePost = (id: string): FeedItem => ({
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
    permissions: {
      canReply: true,
      canDelete: false,
      canPin: false,
      canViewSources: false,
    },
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
  });

function PostProbe({
  postId,
  onRender,
}: {
  postId: string;
  onRender: (post: FeedItem | null) => void;
}) {
  onRender(usePostSelector(postId));
  return null;
}

function FeedProbe({
  type,
  onRender,
}: {
  type: FeedType;
  onRender: (items: FeedItem[]) => void;
}) {
  onRender(useFeedSelector(type).items);
  return null;
}

function UserFeedProbe({
  userId,
  onRender,
}: {
  userId: string;
  onRender: (items: FeedItem[]) => void;
}) {
  onRender(useUserFeedSelector(userId, 'posts').items);
  return null;
}

describe('postsStore keyed SQLite reactivity', () => {
  beforeAll(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    mockPosts.clear();
    mockFeedIds.clear();
    mockFeedMeta.clear();
    mockPostReadCounts.clear();
    mockPostWriteCounts.clear();
    mockFeedReadCounts.clear();
    mockClearAllCachedData.mockClear();
    mockFeedService.getSavedPosts.mockReset();
    mockFeedService.getUserFeed.mockReset();
    mockFeedService.getPostById.mockReset();
  });

  it('persists canonical related posts once without recreating local aliases', () => {
    const boostOriginal = makePost('boost-original');
    const boost = makePost('boost');
    boost.content = { text: '' };
    boost.originalPost = boostOriginal;
    boost.boost = {
      actor: boost.user,
      originalPost: boostOriginal,
    };

    const quotedPost = makePost('quoted-post');
    const quote = makePost('quote');
    quote.originalPost = quotedPost;
    quote.quotedPost = quotedPost;

    act(() => {
      usePostsStore.getState().cachePosts([boost, quote]);
    });

    expect(mockPosts.get('boost')?.boost?.originalPost?.id).toBe('boost-original');
    expect(mockPosts.get('quote')?.quotedPost?.id).toBe('quoted-post');
    expect(mockPosts.get('boost')).not.toHaveProperty('original');
    expect(mockPosts.get('quote')).not.toHaveProperty('quoted');
    expect(mockPostWriteCounts.get('boost-original')).toBe(1);
    expect(mockPostWriteCounts.get('quoted-post')).toBe(1);
  });

  it('updates only the changed post without re-reading either feed', () => {
    const postA = makePost('granular-a');
    const postB = makePost('granular-b');
    act(() => {
      usePostsStore.getState().addPostsToFeed([postA], 'posts');
      usePostsStore.getState().addPostsToFeed([postB], 'following');
    });

    const postARenders = jest.fn();
    const postBRenders = jest.fn();
    const postsFeedRenders = jest.fn();
    const followingFeedRenders = jest.fn();
    let renderer!: TestRenderer.ReactTestRenderer;

    act(() => {
      renderer = TestRenderer.create(
        <>
          <PostProbe postId={postA.id} onRender={postARenders} />
          <PostProbe postId={postB.id} onRender={postBRenders} />
          <FeedProbe type="posts" onRender={postsFeedRenders} />
          <FeedProbe type="following" onRender={followingFeedRenders} />
        </>
      );
    });

    const postABefore = postARenders.mock.calls.length;
    const postBBefore = postBRenders.mock.calls.length;
    const postsFeedBefore = postsFeedRenders.mock.calls.length;
    const followingFeedBefore = followingFeedRenders.mock.calls.length;
    const postsReadsBefore = mockFeedReadCounts.get('posts') ?? 0;
    const followingReadsBefore = mockFeedReadCounts.get('following') ?? 0;

    act(() => {
      usePostsStore.getState().updatePostEverywhere(postA.id, (previous) => ({
        ...previous,
        engagement: {
          ...previous.engagement,
          likes: (previous.engagement.likes ?? 0) + 1,
        },
      }));
    });

    expect(postARenders.mock.calls.length).toBeGreaterThan(postABefore);
    expect(postBRenders).toHaveBeenCalledTimes(postBBefore);
    expect(postsFeedRenders).toHaveBeenCalledTimes(postsFeedBefore);
    expect(followingFeedRenders).toHaveBeenCalledTimes(followingFeedBefore);
    expect(mockFeedReadCounts.get('posts') ?? 0).toBe(postsReadsBefore);
    expect(mockFeedReadCounts.get('following') ?? 0).toBe(followingReadsBefore);

    act(() => renderer.unmount());
  });

  it('re-reads only feeds that contained a globally deleted post', () => {
    const removedPost = makePost('delete-target');
    const retainedPost = makePost('delete-retained');
    act(() => {
      usePostsStore.getState().addPostsToFeed([removedPost], 'posts');
      usePostsStore.getState().addPostsToFeed([removedPost], 'following');
      usePostsStore.getState().addPostsToFeed([retainedPost], 'saved');
    });

    const postsRenders = jest.fn();
    const followingRenders = jest.fn();
    const savedRenders = jest.fn();
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        <>
          <FeedProbe type="posts" onRender={postsRenders} />
          <FeedProbe type="following" onRender={followingRenders} />
          <FeedProbe type="saved" onRender={savedRenders} />
        </>
      );
    });

    const rendersBefore = {
      posts: postsRenders.mock.calls.length,
      following: followingRenders.mock.calls.length,
      saved: savedRenders.mock.calls.length,
    };
    const readsBefore = {
      posts: mockFeedReadCounts.get('posts') ?? 0,
      following: mockFeedReadCounts.get('following') ?? 0,
      saved: mockFeedReadCounts.get('saved') ?? 0,
    };

    act(() => usePostsStore.getState().removePostEverywhere(removedPost.id));

    expect(postsRenders.mock.calls.length).toBeGreaterThan(rendersBefore.posts);
    expect(followingRenders.mock.calls.length).toBeGreaterThan(rendersBefore.following);
    expect(savedRenders).toHaveBeenCalledTimes(rendersBefore.saved);
    expect(mockFeedReadCounts.get('posts') ?? 0).toBe(readsBefore.posts + 1);
    expect(mockFeedReadCounts.get('following') ?? 0).toBe(readsBefore.following + 1);
    expect(mockFeedReadCounts.get('saved') ?? 0).toBe(readsBefore.saved);

    act(() => renderer.unmount());
  });

  it('bounds public post and feed snapshot reads', () => {
    const boundedPosts = Array.from({ length: 1_001 }, (_, index) =>
      makePost(`bounded-post-${index}`)
    );
    for (const post of boundedPosts) mockPosts.set(post.id, post);

    let postRenderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      postRenderer = TestRenderer.create(
        <>
          {boundedPosts.map((post) => (
            <PostProbe key={post.id} postId={post.id} onRender={() => undefined} />
          ))}
        </>
      );
    });
    const firstPostReadsBeforeRemount =
      mockPostReadCounts.get(boundedPosts[0].id) ?? 0;
    act(() => postRenderer.unmount());
    act(() => {
      postRenderer = TestRenderer.create(
        <PostProbe postId={boundedPosts[0].id} onRender={() => undefined} />
      );
    });
    expect(mockPostReadCounts.get(boundedPosts[0].id)).toBe(
      firstPostReadsBeforeRemount + 1
    );
    act(() => postRenderer.unmount());

    const userIds = Array.from({ length: 101 }, (_, index) => `bounded-user-${index}`);
    let feedRenderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      feedRenderer = TestRenderer.create(
        <>
          {userIds.map((userId) => (
            <UserFeedProbe key={userId} userId={userId} onRender={() => undefined} />
          ))}
        </>
      );
    });
    const firstFeedKey = mockBuildFeedKey('posts', userIds[0]);
    const firstFeedReadsBeforeRemount = mockFeedReadCounts.get(firstFeedKey) ?? 0;
    act(() => feedRenderer.unmount());
    act(() => {
      feedRenderer = TestRenderer.create(
        <UserFeedProbe userId={userIds[0]} onRender={() => undefined} />
      );
    });
    expect(mockFeedReadCounts.get(firstFeedKey)).toBe(
      firstFeedReadsBeforeRemount + 1
    );
    act(() => feedRenderer.unmount());
  });

  it('removes post/feed snapshots and persistence at an identity boundary', () => {
    const privatePost = makePost('viewer-a-private-post');
    act(() => {
      usePostsStore.getState().addPostsToFeed([privatePost], 'saved');
    });

    const postRenders = jest.fn();
    const feedRenders = jest.fn();
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        <>
          <PostProbe postId={privatePost.id} onRender={postRenders} />
          <FeedProbe type="saved" onRender={feedRenders} />
        </>,
      );
    });

    expect(postRenders).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: privatePost.id }),
    );
    expect(feedRenders).toHaveBeenLastCalledWith([
      expect.objectContaining({ id: privatePost.id }),
    ]);

    act(() => {
      usePostsStore.getState().resetViewerState();
    });

    expect(mockClearAllCachedData).toHaveBeenCalledTimes(1);
    expect(postRenders).toHaveBeenLastCalledWith(null);
    expect(feedRenders).toHaveBeenLastCalledWith([]);
    expect(usePostsStore.getState().feedUI).toEqual({});
    expect(usePostsStore.getState().lastRefresh).toBe(0);

    act(() => renderer.unmount());
  });

  it('discards an old viewer response that settles after the reset', async () => {
    let resolveRequest!: (value: {
      data: { posts: FeedItem[]; hasMore: boolean };
    }) => void;
    let requestSignal: AbortSignal | undefined;
    mockFeedService.getSavedPosts.mockImplementationOnce(
      (request: { signal?: AbortSignal }) => new Promise((resolve) => {
        requestSignal = request.signal;
        resolveRequest = resolve;
      }),
    );

    let request!: Promise<void>;
    act(() => {
      request = usePostsStore.getState().fetchSavedPosts({});
    });
    act(() => {
      usePostsStore.getState().resetViewerState();
    });
    expect(requestSignal?.aborted).toBe(true);

    await act(async () => {
      resolveRequest({
        data: {
          posts: [makePost('late-viewer-a-post')],
          hasMore: false,
        },
      });
      await request;
    });

    expect(mockPosts.has('late-viewer-a-post')).toBe(false);
    expect(mockFeedIds.get('saved')).toBeUndefined();
    expect(usePostsStore.getState().lastRefresh).toBe(0);
  });

  it('aborts profile and detail reads at an identity boundary', async () => {
    let resolveProfile!: (value: {
      items: FeedItem[];
      hasMore: boolean;
      pending: boolean;
    }) => void;
    let resolveDetail!: (value: FeedItem) => void;
    let profileSignal: AbortSignal | undefined;
    let detailSignal: AbortSignal | undefined;

    mockFeedService.getUserFeed.mockImplementationOnce(
      (
        _userId: string,
        _request: unknown,
        options: { signal?: AbortSignal },
      ) => new Promise((resolve) => {
        profileSignal = options.signal;
        resolveProfile = resolve;
      }),
    );
    mockFeedService.getPostById.mockImplementationOnce(
      (_postId: string, signal?: AbortSignal) => new Promise((resolve) => {
        detailSignal = signal;
        resolveDetail = resolve;
      }),
    );

    let profileRequest!: Promise<{ pending: boolean }>;
    let detailRequest!: Promise<unknown>;
    act(() => {
      profileRequest = usePostsStore
        .getState()
        .fetchUserFeed('profile-a', { type: 'media' });
      detailRequest = usePostsStore.getState().getPostById('private-post');
    });

    act(() => {
      usePostsStore.getState().resetViewerState();
    });

    expect(profileSignal?.aborted).toBe(true);
    expect(detailSignal?.aborted).toBe(true);

    await act(async () => {
      resolveProfile({ items: [], hasMore: false, pending: false });
      resolveDetail(makePost('private-post'));
      await Promise.all([profileRequest, detailRequest]);
    });

    expect(mockPosts.has('private-post')).toBe(false);
  });
});
