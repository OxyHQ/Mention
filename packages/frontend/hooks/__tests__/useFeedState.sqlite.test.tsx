import TestRenderer, { act } from 'react-test-renderer';
import { QueryClientProvider } from '@tanstack/react-query';
import { queryClient } from '@/lib/queryClient';
import { usePostsStore } from '@/stores/postsStore';
import { feedService } from '@/services/feedService';
import { hasFeedData } from '@/db';
import { invalidateSafetyFilters, resetSafetyInvalidation } from '@/stores/safetyInvalidation';
import { noteChannelBylineChanged, resetBylineInvalidation } from '@/stores/bylineInvalidation';
import { useFeedState, type UseFeedStateOptions, type UseFeedStateReturn } from '../useFeedState';
import { FED_PENDING_POLL_DELAYS_MS } from '../useFeedQuery';

(globalThis as { __DEV__?: boolean }).__DEV__ = false;

interface MockFeed {
  items: { id: string }[];
  hasMore: boolean;
  isLoading: boolean;
  error: string | null;
  errorKind?: string;
  nextCursor?: string;
}

let mockFeed: MockFeed | undefined;

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
    feedUI: {} as Record<string, { lastUpdated: number }>,
  };
  const usePostsStore = (selector: (value: typeof state) => unknown) => selector(state);
  usePostsStore.getState = () => state;
  return {
    usePostsStore,
    useFeedSelector: () => mockFeed,
    useUserFeedSelector: () => mockFeed,
  };
});

jest.mock('@/services/feedService', () => ({
  feedService: { getFeed: jest.fn(), getUserFeed: jest.fn() },
}));

jest.mock('@/db', () => ({
  buildFeedKey: jest.fn(() => 'feed-key'),
  hasFeedData: jest.fn(() => false),
  isDbAvailable: jest.fn(() => true),
}));

jest.mock('@oxy.so/core/logger', () => ({
  ...jest.requireActual('@oxy.so/core/logger'),
  createLogger: () => ({ debug: jest.fn(), error: jest.fn(), warn: jest.fn() }),
}));

jest.mock('@/lib/precacheActorsFromPosts', () => ({
  precacheActorsFromPosts: jest.fn(),
}));

type Store = ReturnType<typeof usePostsStore.getState>;
const store = (): Store => usePostsStore.getState();
const mocked = (fn: unknown) => fn as jest.Mock;

const home: UseFeedStateOptions = {
  type: 'for_you',
  isAuthenticated: true,
  currentUserId: 'viewer-a',
};
const profile: UseFeedStateOptions = { ...home, type: 'posts', userId: 'author-1' };

let latest: UseFeedStateReturn | undefined;

function Probe({ options }: { options: UseFeedStateOptions }) {
  latest = useFeedState(options);
  return null;
}

function tree(options: UseFeedStateOptions) {
  return (
    <QueryClientProvider client={queryClient}>
      <Probe options={options} />
    </QueryClientProvider>
  );
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

const open = new Set<TestRenderer.ReactTestRenderer>();

async function mount(options: UseFeedStateOptions): Promise<TestRenderer.ReactTestRenderer> {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(tree(options));
  });
  await flush();
  open.add(renderer);
  return renderer;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe('useFeedState on the SQLite path', () => {
  beforeAll(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    latest = undefined;
    jest.clearAllMocks();
    queryClient.clear();
    resetSafetyInvalidation();
    resetBylineInvalidation();
    store().feedUI = {};
    mocked(hasFeedData).mockReturnValue(false);
    mocked(store().fetchUserFeed).mockImplementation(() => Promise.resolve({ pending: false }));
    mockFeed = {
      items: [{ id: 'row-1' }],
      hasMore: true,
      isLoading: false,
      error: null,
      nextCursor: 'cursor-2',
    };
  });

  afterEach(() => {
    for (const renderer of open) {
      act(() => renderer.unmount());
    }
    open.clear();
    jest.useRealTimers();
  });

  it("reads the store's feed and never a feed query", async () => {
    await mount(home);

    expect(store().fetchFeed).toHaveBeenCalledWith({
      type: 'for_you',
      limit: 20,
      filters: undefined,
    });
    expect(feedService.getFeed).not.toHaveBeenCalled();
    expect(latest?.items).toEqual([{ id: 'row-1' }]);
    expect(latest?.hasMore).toBe(true);
    expect(latest?.feedScrollKey).toBe('auth:viewer-a|for_you||');
  });

  it("shows a previous session's rows at once and refreshes them in the background", async () => {
    mocked(hasFeedData).mockReturnValue(true);

    await mount(home);
    expect(store().fetchFeed).toHaveBeenCalledTimes(1);

    jest.clearAllMocks();
    await mount(profile);
    expect(store().fetchUserFeed).toHaveBeenCalledWith('author-1', {
      type: 'posts',
      limit: 20,
      filters: undefined,
    });
  });

  it("reports the store's error and its kind, and clears it through the store", async () => {
    mockFeed = {
      items: [],
      hasMore: false,
      isLoading: false,
      error: 'Failed to load',
      errorKind: 'offline',
    };
    await mount(home);

    expect(latest?.error).toBe('Failed to load');
    expect(latest?.errorKind).toBe('offline');
    act(() => latest!.clearError());
    expect(store().clearError).toHaveBeenCalled();

    mockFeed = undefined;
    await mount(home);
    expect(latest?.items).toEqual([]);
    expect(latest?.errorKind).toBeNull();
    expect(latest?.hasMore).toBe(false);
  });

  it("waits for a signed-in viewer's id before reading anything", async () => {
    await mount({ ...home, currentUserId: undefined });

    expect(store().fetchFeed).not.toHaveBeenCalled();
  });

  it("swallows a failed first page into the store's error rather than throwing", async () => {
    mocked(store().fetchFeed).mockRejectedValueOnce({ status: 500 });

    await mount(home);
    await act(async () => {
      await latest!.fetchInitial(true);
    });

    expect(store().refreshFeed).toHaveBeenCalledTimes(1);
  });

  describe('refresh', () => {
    it('refreshes a home feed through the store, and a profile by reading it again', async () => {
      await mount(home);
      await act(async () => {
        await latest!.refresh();
      });
      expect(store().refreshFeed).toHaveBeenCalledWith('for_you', undefined);

      await mount(profile);
      await act(async () => {
        await latest!.refresh();
      });
      expect(store().fetchUserFeed).toHaveBeenLastCalledWith('author-1', {
        type: 'posts',
        limit: 20,
        filters: undefined,
      });
    });

    it('resolves when the refresh fails, and a superseded refresh says nothing', async () => {
      await mount(home);
      const first = deferred<void>();
      mocked(store().refreshFeed)
        .mockImplementationOnce(() => first.promise)
        .mockRejectedValueOnce({ status: 503 });

      let firstDone!: Promise<void>;
      act(() => {
        firstDone = latest!.refresh();
      });
      await act(async () => {
        await latest!.refresh();
      });
      first.reject({ status: 503 });
      await act(async () => {
        await firstDone;
      });
      expect(store().refreshFeed).toHaveBeenCalledTimes(2);
    });
  });

  describe('load more', () => {
    it('pages a home feed through the store, and a profile by its cursor', async () => {
      await mount(home);
      await act(async () => {
        await latest!.loadMore();
      });
      expect(store().loadMoreFeed).toHaveBeenCalledWith('for_you', undefined);

      await mount(profile);
      await act(async () => {
        await latest!.loadMore();
      });
      expect(store().fetchUserFeed).toHaveBeenLastCalledWith('author-1', {
        type: 'posts',
        limit: 20,
        cursor: 'cursor-2',
        filters: undefined,
      });
    });

    it('fires once while a page is in flight, and not while the first page loads', async () => {
      await mount(home);
      const next = deferred<void>();
      mocked(store().loadMoreFeed).mockImplementationOnce(() => next.promise);

      let pending!: Promise<void>;
      act(() => {
        pending = latest!.loadMore();
      });
      await act(async () => {
        await latest!.loadMore();
      });
      expect(store().loadMoreFeed).toHaveBeenCalledTimes(1);
      next.resolve();
      await act(async () => {
        await pending;
      });

      const refreshing = deferred<void>();
      mocked(store().refreshFeed).mockImplementationOnce(() => refreshing.promise);
      let refreshed!: Promise<void>;
      act(() => {
        refreshed = latest!.refresh();
      });
      await act(async () => {
        await latest!.loadMore();
      });
      expect(store().loadMoreFeed).toHaveBeenCalledTimes(1);
      refreshing.resolve();
      await act(async () => {
        await refreshed;
      });
    });

    it('drops a page a refresh superseded, and reports a failed page', async () => {
      await mount(home);
      const stale = deferred<void>();
      mocked(store().loadMoreFeed)
        .mockImplementationOnce(() => stale.promise)
        .mockRejectedValueOnce({ status: 500 });

      let stalePage!: Promise<void>;
      act(() => {
        stalePage = latest!.loadMore();
      });
      await act(async () => {
        await latest!.refresh();
      });
      stale.reject(new Error('aborted'));
      await act(async () => {
        await stalePage;
      });

      await act(async () => {
        await latest!.loadMore();
      });
      expect(store().loadMoreFeed).toHaveBeenCalledTimes(2);
    });
  });

  it('reads again on a reload key change, a safety rule or a byline change', async () => {
    const renderer = await mount({ ...home, reloadKey: 1 });
    expect(store().refreshFeed).not.toHaveBeenCalled();

    await act(async () => {
      renderer.update(tree({ ...home, reloadKey: 2 }));
    });
    await flush();
    expect(store().refreshFeed).toHaveBeenCalledTimes(1);

    await act(async () => {
      invalidateSafetyFilters();
    });
    await act(async () => {
      noteChannelBylineChanged('channel-1');
    });
    expect(store().refreshFeed).toHaveBeenCalledTimes(3);
  });

  it("clears the previous viewer's feed and reads it again for the next one", async () => {
    const renderer = await mount(home);
    await act(async () => {
      renderer.update(tree({ ...home, currentUserId: 'viewer-b' }));
    });
    await flush();
    expect(store().clearFeed).toHaveBeenCalledWith('for_you');
    expect(store().refreshFeed).toHaveBeenCalledTimes(1);

    const profileRenderer = await mount(profile);
    await act(async () => {
      profileRenderer.update(tree({ ...profile, currentUserId: 'viewer-b' }));
    });
    await flush();
    expect(store().clearUserFeed).toHaveBeenCalledWith('author-1', 'posts');
  });

  describe('a federated profile still syncing', () => {
    async function advance(ms: number): Promise<void> {
      await act(async () => {
        await jest.advanceTimersByTimeAsync(ms);
      });
    }

    it('re-reads on the bounded budget, then shows the empty state', async () => {
      jest.useFakeTimers();
      mocked(store().fetchUserFeed).mockImplementation(() => Promise.resolve({ pending: true }));
      let renderer!: TestRenderer.ReactTestRenderer;
      await act(async () => {
        renderer = TestRenderer.create(tree(profile));
      });
      open.add(renderer);
      await advance(0);
      expect(latest?.pending).toBe(true);

      const budget = FED_PENDING_POLL_DELAYS_MS.reduce((sum, delay) => sum + delay, 0);
      await advance(budget + 60_000);
      expect(store().fetchUserFeed).toHaveBeenCalledTimes(1 + FED_PENDING_POLL_DELAYS_MS.length);
      expect(latest?.pending).toBe(true);
    });

    it('stops as soon as posts arrive', async () => {
      jest.useFakeTimers();
      mocked(store().fetchUserFeed)
        .mockImplementationOnce(() => Promise.resolve({ pending: true }))
        .mockImplementation(() => Promise.resolve({ pending: false }));
      let renderer!: TestRenderer.ReactTestRenderer;
      await act(async () => {
        renderer = TestRenderer.create(tree(profile));
      });
      open.add(renderer);
      await advance(FED_PENDING_POLL_DELAYS_MS[0]);

      expect(latest?.pending).toBe(false);
      await advance(60_000);
      expect(store().fetchUserFeed).toHaveBeenCalledTimes(2);
    });
  });
});
