import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { HydratedPost } from '@mention/shared-types';
import enMessages from '@/locales/en.json';
import { queryClient } from '@/lib/queryClient';
import {
  invalidateEngagementLists,
  resetEngagementInvalidation,
} from '@/stores/engagementInvalidation';

/**
 * Saving a post and then OPENING the saved screen must show that post.
 *
 * The failure this covers is invisible from either side on its own: the write
 * reaches the server, the saved screen's query key matches the key the save
 * invalidates, and the screen refetches correctly while it is mounted. What
 * breaks is the case the user actually performs — save from the feed, where the
 * saved screen is NOT mounted, then navigate to it. `invalidateQueries` only
 * REFETCHES active queries; an inactive one is marked stale and left for its
 * next mount to revalidate. Whether that mount revalidates is decided entirely
 * by the client-wide `refetchOnMount`, so the real `QUERY_CLIENT_CONFIG` is the
 * code under test here and is deliberately not replaced with test defaults.
 *
 * Both surfaces share ONE QueryClient, as they do in the app, and the second
 * visit is a real unmount/remount — no reload, no cache reset, no forced
 * refetch. Mocks stop at the module boundary: the HTTP service, the SQLite-backed
 * post store, the window-virtualized list widget, and the SDK/Bloom packages
 * that ship untranspiled TS. The screen's query, the save hook's invalidation
 * and the query client's defaults are all real.
 */

type MessageNode = string | number | boolean | null | MessageNode[] | { [key: string]: MessageNode };
const messages: { [key: string]: MessageNode } = enMessages;

function mockTranslate(key: string, fallback?: string): string {
  const value = key
    .split('.')
    .reduce<MessageNode | undefined>(
      (node, part) =>
        typeof node === 'object' && node !== null && !Array.isArray(node)
          ? node[part]
          : undefined,
      messages,
    );
  return typeof value === 'string' ? value : (fallback ?? key);
}

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: mockTranslate }),
}));

jest.mock('expo-router', () => ({
  router: { push: jest.fn() },
  useRouter: () => ({ push: jest.fn() }),
  usePathname: () => '/saved',
  useLocalSearchParams: () => ({}),
  useFocusEffect: jest.fn(),
  Link: () => null,
}));

jest.mock('expo-router/head', () => ({ __esModule: true, default: () => null }));
jest.mock('expo-status-bar', () => ({ StatusBar: () => null }));

jest.mock('@/hooks/useSafeBack', () => ({ useSafeBack: () => jest.fn() }));

const mockAuth = {
  user: { id: 'viewer-1' },
  canUsePrivateApi: true,
  isPrivateApiPending: false,
};

jest.mock('@oxyhq/services/ui/client', () => ({ useAuth: () => mockAuth }));

jest.mock('@oxyhq/bloom/theme', () => ({
  useTheme: () => ({
    isDark: false,
    colors: {
      primary: '#0000ff',
      text: '#000000',
      textSecondary: '#666666',
      border: '#cccccc',
      background: '#ffffff',
      card: '#ffffff',
    },
  }),
}));

jest.mock('@oxyhq/bloom/loading', () => {
  const { View } = jest.requireActual<typeof import('react-native')>('react-native');
  return { Loading: () => <View testID="spinner" /> };
});

jest.mock('@oxyhq/bloom/button', () => {
  const { Text, TouchableOpacity } =
    jest.requireActual<typeof import('react-native')>('react-native');
  return {
    Button: ({ children, onPress }: { children?: React.ReactNode; onPress?: () => void }) => (
      <TouchableOpacity accessibilityRole="button" onPress={onPress}>
        <Text>{children}</Text>
      </TouchableOpacity>
    ),
  };
});

jest.mock('@oxyhq/bloom/dialog', () => {
  const { View } = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    Dialog: ({ children }: { children?: React.ReactNode }) => <View>{children}</View>,
    useDialogControl: () => ({ open: jest.fn(), close: jest.fn() }),
  };
});

jest.mock('@oxyhq/bloom/search', () => {
  const { View } = jest.requireActual<typeof import('react-native')>('react-native');
  return { Search: () => <View testID="search" /> };
});

jest.mock('@oxyhq/bloom/text-field', () => {
  const { View } = jest.requireActual<typeof import('react-native')>('react-native');
  const Passthrough = ({ children }: { children?: React.ReactNode }) => <View>{children}</View>;
  return { TextField: Passthrough, TextFieldInput: () => <View testID="text-input" /> };
});

jest.mock('@/components/common/AnimatedTabBar', () => {
  const { View } = jest.requireActual<typeof import('react-native')>('react-native');
  return { __esModule: true, default: () => <View testID="folder-tabs" /> };
});

jest.mock('@/components/BottomBarAwareFab', () => {
  const { View } = jest.requireActual<typeof import('react-native')>('react-native');
  return { BottomBarAwareFab: () => <View testID="fab" /> };
});

jest.mock('@/components/shell/PanelChrome', () => {
  const { View } = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    PanelStickyHeader: ({ children }: { children?: React.ReactNode }) => <View>{children}</View>,
  };
});

// The saved list is virtualized against `window` on web. The rows are not the
// code under test — what the screen DERIVES from its query is, so the mock
// renders exactly the post ids it was handed.
jest.mock('@/components/saved/SavedPostsList', () => {
  const { Text, View } = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    __esModule: true,
    default: ({
      posts,
      empty,
    }: {
      posts: { id: string }[];
      empty: React.ReactNode;
    }) => (
      <View testID="saved-list">
        {posts.length === 0 ? empty : null}
        {posts.map((post) => (
          <Text key={post.id}>{`saved:${post.id}`}</Text>
        ))}
      </View>
    ),
  };
});

// ── The server, and the HTTP boundary in front of it ─────────────────────────

/** Post ids the server currently reports as saved, newest first. */
let mockServerSaved: string[] = [];

const mockGetSavedPosts = jest.fn(
  async ({ page = 1, limit = 30 }: { page?: number; limit?: number }) => ({
    success: true,
    data: {
      posts: mockServerSaved.map((id) => ({ id, content: { text: id } }) as unknown as HydratedPost),
      hasMore: false,
      page,
      limit,
    },
  }),
);

jest.mock('@/services/feedService', () => ({
  feedService: {
    getSavedPosts: (...args: [{ page?: number; limit?: number }]) => mockGetSavedPosts(...args),
    getBookmarkFolders: async () => [],
    moveBookmarkToFolder: async () => undefined,
  },
}));

// The real store's contract, reduced to the two things this screen depends on:
// the write is awaited, and a write that lands reports the list it changed. The
// store itself is SQLite-backed, so only that boundary is replaced; that it
// really makes this call is asserted against the actual store in
// `stores/__tests__/engagementInvalidationWiring.test.ts`.
const mockPostsStore = {
  cachePosts: jest.fn(),
  savePost: jest.fn(async ({ postId }: { postId: string }) => {
    mockServerSaved = [postId, ...mockServerSaved];
    invalidateEngagementLists('save');
  }),
  unsavePost: jest.fn(async ({ postId }: { postId: string }) => {
    mockServerSaved = mockServerSaved.filter((id) => id !== postId);
    invalidateEngagementLists('save');
  }),
};

jest.mock('@/stores/postsStore', () => ({
  usePostsStore: (selector?: (state: typeof mockPostsStore) => unknown) =>
    selector ? selector(mockPostsStore) : mockPostsStore,
}));

import SavedPostsScreen from '../saved';
import { usePostSave } from '@/hooks/usePostSave';

// ── Helpers ──────────────────────────────────────────────────────────────────

type JsonNode = TestRenderer.ReactTestRendererJSON | string | null;

function collectText(node: JsonNode | JsonNode[]): string[] {
  if (node === null || node === undefined) return [];
  if (typeof node === 'string') return [node];
  if (Array.isArray(node)) return node.flatMap(collectText);
  return (node.children ?? []).flatMap((child) => collectText(child as JsonNode));
}

function renderedText(renderer: TestRenderer.ReactTestRenderer): string {
  return collectText(renderer.toJSON() as JsonNode | JsonNode[]).join(' | ');
}

async function settle(client: QueryClient, tries = 25): Promise<void> {
  for (let attempt = 0; attempt < tries; attempt += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    if (client.isFetching() === 0 && client.isMutating() === 0) return;
  }
  throw new Error('React Query never settled');
}

const renderers: TestRenderer.ReactTestRenderer[] = [];

/**
 * The app's OWN client — the module singleton `app/_layout.tsx` mounts, built
 * from the real shared defaults. Substituting a client with test defaults would
 * remove the thing this file exists to protect, and a second client would not be
 * the one `postsStore` invalidates.
 */
function appClient(): QueryClient {
  return queryClient;
}

/** Open the saved screen, as a navigation would: a fresh mount. */
async function openSavedScreen(client: QueryClient): Promise<TestRenderer.ReactTestRenderer> {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <QueryClientProvider client={client}>
        <SavedPostsScreen />
      </QueryClientProvider>,
    );
  });
  await settle(client);
  renderers.push(renderer);
  return renderer;
}

/** Leave the saved screen. Its query stays cached, and becomes inactive. */
function closeScreen(renderer: TestRenderer.ReactTestRenderer): void {
  act(() => {
    renderer.unmount();
  });
}

/**
 * Save a post from a feed row — the real `usePostSave`, mounted on its own as
 * `PostItem` mounts it, with the saved screen nowhere in the tree.
 */
async function savePostFromFeed(client: QueryClient, postId: string): Promise<void> {
  let toggleSave: (() => Promise<void>) | undefined;

  function FeedRow() {
    toggleSave = usePostSave(postId, false, 'for_you');
    return null;
  }

  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(
      <QueryClientProvider client={client}>
        <FeedRow />
      </QueryClientProvider>,
    );
  });

  await act(async () => {
    await toggleSave?.();
  });
  await settle(client);

  act(() => {
    renderer.unmount();
  });
}

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  jest.clearAllMocks();
  resetEngagementInvalidation();
  mockServerSaved = [];
});

afterEach(() => {
  for (const renderer of renderers.splice(0)) {
    act(() => {
      renderer.unmount();
    });
  }
  // One shared client across the file, as in the app. Clearing it isolates the
  // cases from each other and disarms the real config's 30-minute
  // garbage-collection timers, which would otherwise outlive the run.
  queryClient.clear();
});

describe('saved screen revalidation after a save', () => {
  it('shows a post saved from the feed on the next visit, with no reload', async () => {
    const client = appClient();
    mockServerSaved = ['post-existing'];

    // First visit: the viewer already has one saved post.
    const firstVisit = await openSavedScreen(client);
    expect(renderedText(firstVisit)).toContain('saved:post-existing');
    closeScreen(firstVisit);

    // Back on the feed, the viewer saves another post.
    await savePostFromFeed(client, 'post-new');
    expect(mockPostsStore.savePost).toHaveBeenCalledWith({ postId: 'post-new' }, 'for_you');
    expect(mockServerSaved).toContain('post-new');

    // Second visit — a plain navigation, not a reload.
    const secondVisit = await openSavedScreen(client);
    expect(renderedText(secondVisit)).toContain('saved:post-new');
    expect(renderedText(secondVisit)).toContain('saved:post-existing');
  });

  it('drops a post unsaved from the feed on the next visit, with no reload', async () => {
    const client = appClient();
    mockServerSaved = ['post-a', 'post-b'];

    const firstVisit = await openSavedScreen(client);
    expect(renderedText(firstVisit)).toContain('saved:post-a');
    closeScreen(firstVisit);

    let toggleSave: (() => Promise<void>) | undefined;
    function FeedRow() {
      toggleSave = usePostSave('post-a', true);
      return null;
    }
    let feedRenderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      feedRenderer = TestRenderer.create(
        <QueryClientProvider client={client}>
          <FeedRow />
        </QueryClientProvider>,
      );
    });
    await act(async () => {
      await toggleSave?.();
    });
    await settle(client);
    act(() => {
      feedRenderer.unmount();
    });

    const secondVisit = await openSavedScreen(client);
    expect(renderedText(secondVisit)).not.toContain('saved:post-a');
    expect(renderedText(secondVisit)).toContain('saved:post-b');
  });

  it('serves the cached list without a request when nothing invalidated it', async () => {
    const client = appClient();
    mockServerSaved = ['post-existing'];

    const firstVisit = await openSavedScreen(client);
    closeScreen(firstVisit);
    expect(mockGetSavedPosts).toHaveBeenCalledTimes(1);

    // No write happened, and the list is still inside its own `staleTime`, so
    // reopening the screen must paint from cache and spend no request. This is
    // the property a blanket "always refetch" would destroy.
    const secondVisit = await openSavedScreen(client);
    expect(mockGetSavedPosts).toHaveBeenCalledTimes(1);
    expect(renderedText(secondVisit)).toContain('saved:post-existing');
  });
});
