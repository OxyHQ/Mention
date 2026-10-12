import TestRenderer, { act } from 'react-test-renderer';
import { QueryClientProvider } from '@tanstack/react-query';
import type { HydratedPost, SlicedFeedResponse } from '@mention/shared-types';
import { feedService } from '@/services/feedService';
import { queryClient } from '@/lib/queryClient';
import { viewerQueryKeys } from '@/lib/viewerQueryKeys';
import { publishNewLocalReply, type FeedQueryData } from '@/stores/feedQueryCache';
import { useFeedState, type UseFeedStateOptions, type UseFeedStateReturn } from '../useFeedState';

(globalThis as { __DEV__?: boolean }).__DEV__ = false;

jest.mock('@/stores/postsStore', () => {
  const state = {
    fetchFeed: jest.fn(() => Promise.resolve()),
    fetchUserFeed: jest.fn(() => Promise.resolve({ pending: false })),
    refreshFeed: jest.fn(() => Promise.resolve()),
    loadMoreFeed: jest.fn(() => Promise.resolve()),
    cachePosts: jest.fn(),
    clearFeed: jest.fn(),
    clearUserFeed: jest.fn(),
    clearError: jest.fn(),
    feedUI: {},
  };
  const usePostsStore = (selector: (value: typeof state) => unknown) => selector(state);
  usePostsStore.getState = () => state;
  return {
    usePostsStore,
    useFeedSelector: () => undefined,
    useUserFeedSelector: () => undefined,
  };
});

jest.mock('@/services/feedService', () => ({
  feedService: {
    getFeed: jest.fn(),
    getUserFeed: jest.fn(),
  },
}));

jest.mock('@/db', () => ({
  buildFeedKey: jest.fn(() => 'feed-key'),
  hasFeedData: jest.fn(() => false),
  isDbAvailable: jest.fn(() => false),
}));

jest.mock('@oxy.so/core/logger', () => ({
  ...jest.requireActual('@oxy.so/core/logger'),
  createLogger: () => ({
    debug: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
  }),
}));

jest.mock('@/lib/precacheActorsFromPosts', () => ({
  precacheActorsFromPosts: jest.fn(),
}));

function reply(id: string, parentPostId: string): HydratedPost {
  return { id, parentPostId, user: { id: 'viewer-a' } } as unknown as HydratedPost;
}

function page(items: HydratedPost[]): SlicedFeedResponse {
  return {
    items,
    slices: [],
    interstitials: [],
    hasMore: false,
    totalCount: items.length,
  };
}

let latest: UseFeedStateReturn | undefined;

function Probe({ options }: { options: UseFeedStateOptions }) {
  latest = useFeedState(options);
  return null;
}

const threadOptions = (parent: string): UseFeedStateOptions => ({
  type: 'replies',
  filters: { postId: parent, parentPostId: parent },
  useScoped: true,
  isAuthenticated: true,
  currentUserId: 'viewer-a',
});

async function flush(): Promise<void> {
  for (let i = 0; i < 3; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function mount(options: UseFeedStateOptions): Promise<TestRenderer.ReactTestRenderer> {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <QueryClientProvider client={queryClient}>
        <Probe options={options} />
      </QueryClientProvider>,
    );
  });
  await flush();
  return renderer;
}

describe('useFeedState: the viewer’s own new reply', () => {
  beforeAll(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    latest = undefined;
    jest.clearAllMocks();
    queryClient.clear();
  });

  it('goes on top of the thread it answers, with no refetch', async () => {
    (feedService.getFeed as jest.Mock).mockResolvedValue(page([reply('r1', 'root')]));
    const renderer = await mount(threadOptions('root'));
    expect(latest?.items.map((item) => item.id)).toEqual(['r1']);
    const readsBefore = (feedService.getFeed as jest.Mock).mock.calls.length;

    act(() => publishNewLocalReply(reply('mine', 'root')));
    await flush();

    expect(latest?.items.map((item) => item.id)).toEqual(['mine', 'r1']);
    expect((feedService.getFeed as jest.Mock).mock.calls.length).toBe(readsBefore);
    // It is in the cache itself, not only on screen, so the thread's next
    // mount paints with it before its revalidation lands.
    const cached = queryClient.getQueryData<FeedQueryData>(
      viewerQueryKeys.feed('viewer-a', 'replies', undefined, {
        postId: 'root',
        parentPostId: 'root',
      }),
    );
    expect(cached?.pages[0].items.map((item) => item.id)).toEqual(['mine', 'r1']);

    act(() => renderer.unmount());
  });

  it('appears in an EMPTY thread — the state the report was about', async () => {
    (feedService.getFeed as jest.Mock).mockResolvedValue(page([]));
    const renderer = await mount(threadOptions('root'));
    expect(latest?.items).toEqual([]);

    act(() => publishNewLocalReply(reply('mine', 'root')));
    await flush();

    expect(latest?.items.map((item) => item.id)).toEqual(['mine']);
    act(() => renderer.unmount());
  });

  it('stays out of a different thread, and is not duplicated', async () => {
    (feedService.getFeed as jest.Mock).mockResolvedValue(page([]));
    const renderer = await mount(threadOptions('other'));

    act(() => publishNewLocalReply(reply('mine', 'root')));
    await flush();
    expect(latest?.items).toEqual([]);

    act(() => publishNewLocalReply(reply('mine-2', 'other')));
    act(() => publishNewLocalReply(reply('mine-2', 'other')));
    await flush();
    expect(latest?.items.map((item) => item.id)).toEqual(['mine-2']);

    act(() => renderer.unmount());
  });

  it('never lands in a feed that is not a replies feed', async () => {
    (feedService.getFeed as jest.Mock).mockResolvedValue(page([]));
    const renderer = await mount({
      type: 'explore',
      filters: { postId: 'root' },
      useScoped: true,
      isAuthenticated: true,
      currentUserId: 'viewer-a',
    });

    act(() => publishNewLocalReply(reply('mine', 'root')));
    await flush();
    expect(latest?.items).toEqual([]);

    act(() => renderer.unmount());
  });

  it('ignores a reply that names no parent', async () => {
    (feedService.getFeed as jest.Mock).mockResolvedValue(page([]));
    const renderer = await mount(threadOptions('root'));

    act(() =>
      publishNewLocalReply({ id: 'orphan', user: { id: 'viewer-a' } } as unknown as HydratedPost),
    );
    await flush();

    expect(latest?.items).toEqual([]);
    act(() => renderer.unmount());
  });
});
