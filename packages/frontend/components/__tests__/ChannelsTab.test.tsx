import React from 'react';
import { Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import type { Channel } from '@mention/shared-types';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ChannelsTab } from '@/components/ChannelsTab';
import { channelsService, type ChannelDirectoryPage } from '@/services/channelsService';
import { viewerQueryKeys } from '@/lib/viewerQueryKeys';

/**
 * Three properties this tab exists for, none of them visible to the type-check.
 *
 * A SIGNED-OUT visitor must see the catalogue. The directory is a
 * reader-agnostic read, so gating the whole tab on a session — the easy mistake,
 * since every other channel surface is authenticated — would leave Explore's new
 * tab blank for exactly the audience discovery is for.
 *
 * A follow taken HERE must stick without refetching. The directory DTO carries
 * no `viewerState` to patch, so the pill reads off a local set; drop that and
 * the button snaps back to "Follow" the moment the request resolves.
 *
 * And nothing may be read before the session resolves, because the viewer id is
 * already in the query key.
 */

// `mock`-prefixed so `jest.mock`'s hoisted factory may close over it.
const mockAuth = {
  user: undefined as { id: string } | undefined,
  canUsePrivateApi: false,
  isAuthResolved: true,
  isPrivateApiPending: false,
};

jest.mock('@oxyhq/services/ui/client', () => ({ useAuth: () => mockAuth }));

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
    i18n: { language: 'en-US' },
  }),
}));

jest.mock('@oxyhq/bloom/theme', () => ({
  useTheme: () => ({ colors: { textSecondary: '#666', card: '#fff', primary: '#7c3aed' } }),
}));

jest.mock('@oxyhq/bloom/loading', () => {
  const { View } = jest.requireActual<typeof import('react-native')>('react-native');
  return { Loading: () => <View />, SpinnerIcon: () => <View /> };
});

jest.mock('@oxyhq/bloom/pressable-scale', () => {
  const { TouchableOpacity } = jest.requireActual<typeof import('react-native')>('react-native');
  return { PressableScale: TouchableOpacity };
});

jest.mock('@oxyhq/bloom/avatar', () => ({ Avatar: () => null }));
jest.mock('@oxyhq/bloom/toast', () => ({ toast: jest.fn() }));

// Bloom's list ships a platform-split ESM entry jest does not transform, and the
// rows are what this asserts on — so render them all, in order, eagerly.
jest.mock('@oxyhq/bloom/list', () => {
  const { View } = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    VirtualList: <T,>({
      data,
      renderItem,
      keyExtractor,
      ListHeaderComponent,
      ListEmptyComponent,
    }: {
      data: T[];
      renderItem: (info: { item: T }) => React.ReactNode;
      keyExtractor: (item: T) => string;
      ListHeaderComponent?: React.ReactNode;
      ListEmptyComponent?: React.ReactNode;
    }) => (
      <View>
        {ListHeaderComponent}
        {data.length === 0
          ? ListEmptyComponent
          : data.map((item) => <View key={keyExtractor(item)}>{renderItem({ item })}</View>)}
      </View>
    ),
  };
});

jest.mock('expo-router', () => ({ router: { push: jest.fn() } }));

// `PanelChrome` imports reanimated, whose worklets runtime cannot initialize
// under jest. Only `Animated.View` is ever touched at runtime, and only by the
// sticky chrome this never renders — so the module loads and the real
// `usePanelChromeTopInset` (plain React context) stays under test.
jest.mock('react-native-reanimated', () => {
  const { View } = jest.requireActual<typeof import('react-native')>('react-native');
  return { __esModule: true, default: { View } };
});

jest.mock('@/services/channelsService', () => ({
  channelsService: {
    listDirectory: jest.fn(),
    follow: jest.fn(),
    unfollow: jest.fn(),
  },
}));

const listDirectory = channelsService.listDirectory as jest.MockedFunction<
  typeof channelsService.listDirectory
>;
const follow = channelsService.follow as jest.MockedFunction<typeof channelsService.follow>;

function makeChannel(id: string): Channel {
  return {
    id,
    handle: `handle-${id}`,
    title: `Channel ${id}`,
    ownerOxyUserId: 'owner-1',
    signPosts: true,
    followerCount: 12,
    postCount: 4,
    createdAt: '2026-08-02T00:00:00.000Z',
    updatedAt: '2026-08-02T00:00:00.000Z',
  } as Channel;
}

function textContent(tree: TestRenderer.ReactTestRenderer): string {
  return tree.root
    .findAllByType(Text)
    .flatMap((node) => node.props.children)
    .filter((child): child is string => typeof child === 'string')
    .join(' | ');
}

/**
 * The follow pills, matched on the props only `ChannelFollowButton` receives.
 *
 * NOT `findAllByType`: that component is `React.memo`, and react-test-renderer
 * compares against the fiber's inner function rather than the memo wrapper, so
 * handing it the exported identity matches NOTHING — every assertion then reads
 * as "no pill rendered" and a broken tab would pass. Verified against this
 * version of react-test-renderer. Nor a pressable-role search, which would also
 * catch the header row and the card itself.
 */
function followPills(tree: TestRenderer.ReactTestRenderer) {
  return tree.root.findAll(
    (node) =>
      typeof node.props.isFollowing === 'boolean' && typeof node.props.isPending === 'boolean',
  );
}

/**
 * Flush until `ready` holds, then stop.
 *
 * Bounded, so a state that never arrives fails by name instead of hanging. Used
 * ONLY for transitions that are a plain `setState` inside `act` — see `mount`
 * for why the arrival of a fetched page is never waited on this way.
 */
async function flushUntil(ready: () => boolean, description: string) {
  for (let pass = 0; pass < 50; pass += 1) {
    if (ready()) return;
    await flush();
  }
  throw new Error(`timed out waiting for ${description}`);
}

/** One macrotask boundary, inside `act`. */
async function flush() {
  await act(async () => {
    await new Promise((resolve) => setImmediate(resolve));
  });
}

const FIRST_PAGE: ChannelDirectoryPage = { items: [makeChannel('a')], hasMore: false };

/**
 * Mount the tab, optionally with the first directory page ALREADY in the cache.
 *
 * Seeding is not a shortcut, it is what makes the render assertions
 * deterministic: react-query resolves its fetch reliably (measured — the queryFn
 * runs once and returns), but the notify that carries the result into this
 * renderer intermittently never lands inside `act`, so a suite that waits for a
 * fetched page to paint fails on a random test roughly one run in three while
 * the component is behaving correctly throughout. A test that red-lights at
 * random is worse than no test, so the fetch round trip is asserted separately,
 * by waiting on the CALL — which is reliable, since it happens during subscribe.
 */
function mount(options: { seeded?: boolean } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (options.seeded) {
    client.setQueryData(viewerQueryKeys.channelDirectory(mockAuth.user?.id), {
      pages: [FIRST_PAGE],
      pageParams: [undefined],
    });
  }
  let tree: TestRenderer.ReactTestRenderer | undefined;
  act(() => {
    tree = TestRenderer.create(
      <QueryClientProvider client={client}>
        <ChannelsTab />
      </QueryClientProvider>,
    );
  });
  if (!tree) throw new Error('ChannelsTab failed to render');
  return tree;
}

describe('ChannelsTab', () => {
  beforeAll(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockAuth.user = undefined;
    mockAuth.canUsePrivateApi = false;
    mockAuth.isAuthResolved = true;
    mockAuth.isPrivateApiPending = false;
    listDirectory.mockResolvedValue(FIRST_PAGE);
  });

  it('reads the directory WITHOUT a session for a signed-out visitor', async () => {
    const tree = mount();
    await flushUntil(() => listDirectory.mock.calls.length > 0, 'the directory read');

    // `authenticated: false` routes it through the public client. Asking the
    // linked one instead buys a 401 with nothing to retry it against, which is
    // how a discovery surface ends up empty for everyone who is not signed in.
    expect(listDirectory).toHaveBeenCalledWith(expect.objectContaining({ authenticated: false }));

    await act(async () => tree.unmount());
  });

  it('reads it WITH the session once the reader has one', async () => {
    mockAuth.user = { id: 'viewer-1' };
    mockAuth.canUsePrivateApi = true;

    const tree = mount();
    await flushUntil(() => listDirectory.mock.calls.length > 0, 'the directory read');

    // Only the authenticated read excludes what the reader already follows,
    // which is what makes every listed row followable by construction.
    expect(listDirectory).toHaveBeenCalledWith(expect.objectContaining({ authenticated: true }));

    await act(async () => tree.unmount());
  });

  it('renders the catalogue to a signed-out visitor with no follow pill', () => {
    const tree = mount({ seeded: true });

    expect(textContent(tree)).toContain('Channel a');
    // Nothing to follow WITH — offering the pill would 401 on tap.
    expect(followPills(tree)).toHaveLength(0);

    act(() => tree.unmount());
  });

  it('offers an unfollowed pill on every row for a signed-in reader', () => {
    mockAuth.user = { id: 'viewer-1' };
    mockAuth.canUsePrivateApi = true;

    const tree = mount({ seeded: true });

    expect(followPills(tree)).toHaveLength(1);
    expect(followPills(tree)[0].props.isFollowing).toBe(false);

    act(() => tree.unmount());
  });

  it('keeps a channel followed after the request resolves', async () => {
    mockAuth.user = { id: 'viewer-1' };
    mockAuth.canUsePrivateApi = true;
    follow.mockResolvedValue(undefined);

    const tree = mount({ seeded: true });
    await act(async () => {
      followPills(tree)[0].props.onPress();
    });
    await flushUntil(() => followPills(tree)[0]?.props.isFollowing === true, 'the pill to flip');

    expect(follow).toHaveBeenCalledWith('a');
    // The row does NOT leave the list: the local set is the whole difference
    // between what the server said and what has since happened, so nothing moves
    // under the reader's scroll position.
    expect(textContent(tree)).toContain('Channel a');

    await act(async () => tree.unmount());
  });

  it('waits for the session to resolve before reading', async () => {
    mockAuth.isPrivateApiPending = true;

    const tree = mount();
    await flush();

    // A read fired mid-restore fetches the signed-out directory and, with the
    // viewer id already in the query key, never corrects itself.
    expect(listDirectory).not.toHaveBeenCalled();

    await act(async () => tree.unmount());
  });
});
