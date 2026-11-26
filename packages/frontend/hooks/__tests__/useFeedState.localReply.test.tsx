import TestRenderer, { act } from 'react-test-renderer';
import { DataProvider, setActiveStore, Store } from '@oxy.so/bloom-data';
import { canonicalPost } from '@/test-support/canonicalPost';
import type { HydratedPost, SlicedFeedResponse } from '@mention/shared-types';
import { feedService } from '@/services/feedService';
import { Feed, feedKey, publishNewLocalReply } from '@/data/feeds';
import type { FeedItem } from '@/db/schema';
import { useFeedState, type UseFeedStateOptions, type UseFeedStateReturn } from '../useFeedState';

(globalThis as { __DEV__?: boolean }).__DEV__ = false;

jest.mock('@/services/feedService', () => ({
  feedService: {
    getFeed: jest.fn(),
    getUserFeed: jest.fn(),
  },
}));

jest.mock('@oxy.so/core/logger', () => ({
  ...jest.requireActual('@oxy.so/core/logger'),
  createLogger: () => ({
    debug: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
  }),
}));

// The feed binds its actor writer (`lib/actorCache`) to the account before
// each read: the SDK's real `User` and `storeUsers`, without loading the whole
// SDK entry.
jest.mock('@oxy.so/services/ui/client', () => ({
  ...require('@/test-support/oxyUsers').oxyUsers,
}));
jest.mock('@/lib/precacheActorsFromPosts', () => ({
  precacheActorsFromPosts: jest.fn(),
}));

function reply(id: string, parentPostId: string): HydratedPost {
  return canonicalPost({ id, parentPostId, user: { id: 'viewer-a' } } as HydratedPost);
}

/** A reply the server accepted, as `postsStore.createReply` hands it to the feeds. */
const accepted = (id: string, parentPostId: string) =>
  reply(id, parentPostId) as unknown as FeedItem;

function page(items: HydratedPost[]): SlicedFeedResponse {
  return {
    items,
    slices: [],
    interstitials: [],
    hasMore: false,
    totalCount: items.length,
  };
}

/** The account's store, as `AccountSwitchReset` provides it. */
let store: Store;

let latest: UseFeedStateReturn | undefined;

function Probe({ options }: { options: UseFeedStateOptions }) {
  latest = useFeedState(options);
  return null;
}

const threadOptions = (parent: string): UseFeedStateOptions => ({
  type: 'replies',
  filters: { postId: parent, parentPostId: parent },
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
      <DataProvider store={store}>
        <Probe options={options} />
      </DataProvider>,
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
    store = new Store();
    setActiveStore(store);
  });

  it('goes on top of the thread it answers, with no refetch', async () => {
    (feedService.getFeed as jest.Mock).mockResolvedValue(page([reply('r1', 'root')]));
    const renderer = await mount(threadOptions('root'));
    expect(latest?.items.map((item) => item.id)).toEqual(['r1']);
    const readsBefore = (feedService.getFeed as jest.Mock).mock.calls.length;

    act(() => publishNewLocalReply(accepted('mine', 'root')));
    await flush();

    expect(latest?.items.map((item) => item.id)).toEqual(['mine', 'r1']);
    expect((feedService.getFeed as jest.Mock).mock.calls.length).toBe(readsBefore);
    // It is in the cache itself, not only on screen, so the thread's next
    // mount paints with it before its revalidation lands.
    const held = Feed.get(
      feedKey({ type: 'replies', filters: { postId: 'root', parentPostId: 'root' } }),
    );
    expect(held?.ids).toEqual(['mine', 'r1']);

    act(() => renderer.unmount());
  });

  it('appears in an EMPTY thread — the state the report was about', async () => {
    (feedService.getFeed as jest.Mock).mockResolvedValue(page([]));
    const renderer = await mount(threadOptions('root'));
    expect(latest?.items).toEqual([]);

    act(() => publishNewLocalReply(accepted('mine', 'root')));
    await flush();

    expect(latest?.items.map((item) => item.id)).toEqual(['mine']);
    act(() => renderer.unmount());
  });

  it('stays out of a different thread, and is not duplicated', async () => {
    (feedService.getFeed as jest.Mock).mockResolvedValue(page([]));
    const renderer = await mount(threadOptions('other'));

    act(() => publishNewLocalReply(accepted('mine', 'root')));
    await flush();
    expect(latest?.items).toEqual([]);

    act(() => publishNewLocalReply(accepted('mine-2', 'other')));
    act(() => publishNewLocalReply(accepted('mine-2', 'other')));
    await flush();
    expect(latest?.items.map((item) => item.id)).toEqual(['mine-2']);

    act(() => renderer.unmount());
  });

  it('never lands in a feed that is not a replies feed', async () => {
    (feedService.getFeed as jest.Mock).mockResolvedValue(page([]));
    const renderer = await mount({
      type: 'explore',
      filters: { postId: 'root' },
      isAuthenticated: true,
      currentUserId: 'viewer-a',
    });

    act(() => publishNewLocalReply(accepted('mine', 'root')));
    await flush();
    expect(latest?.items).toEqual([]);

    act(() => renderer.unmount());
  });

  it('ignores a reply that names no parent', async () => {
    (feedService.getFeed as jest.Mock).mockResolvedValue(page([]));
    const renderer = await mount(threadOptions('root'));

    act(() =>
      publishNewLocalReply({ id: 'orphan', user: { id: 'viewer-a' } } as unknown as FeedItem),
    );
    await flush();

    expect(latest?.items).toEqual([]);
    act(() => renderer.unmount());
  });
});
