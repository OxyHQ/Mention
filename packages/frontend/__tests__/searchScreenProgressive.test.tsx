import React from 'react';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import SearchScreen from '@/app/(app)/search/index';
import { searchService, type SearchAllSource, type SearchResults } from '@/services/searchService';

/**
 * The "All" search tab renders each section as its source answers.
 *
 * Issue #1140: signed in, the screen showed nothing for 8–10s. People and
 * hashtags were ready in well under a second; the posts search took 3–7s, and
 * the tab was one query awaiting all four sources, so everything waited for it.
 * These cases hold the posts source open and check what the viewer sees.
 */

// ── Module boundaries ───────────────────────────────────────────────────────
// Everything the screen renders that is not the search itself is a stub: the
// question is WHICH sections are on screen, not how each card looks.

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string | { defaultValue?: string }) =>
      typeof fallback === 'string' ? fallback : fallback?.defaultValue ?? key,
  }),
}));

jest.mock('expo-router', () => ({
  router: { push: jest.fn() },
  useLocalSearchParams: () => ({ q: 'rust' }),
}));

jest.mock('@oxy.so/services/ui/client', () => ({
  useAuth: () => ({ canUsePrivateApi: true, user: { id: 'viewer-1' } }),
}));

jest.mock('@oxy.so/core', () => ({
  getNormalizedUserHandle: (profile?: { username?: string }) => profile?.username,
}));

// The service's transports. Every source is stubbed on `searchService` below;
// these only have to load.
jest.mock('@/utils/api', () => ({
  authenticatedClient: { get: jest.fn() },
  publicClient: { get: jest.fn() },
  isUnauthorizedError: () => false,
}));
jest.mock('@/lib/oxyServices', () => ({ oxyServices: { httpService: { get: jest.fn() } } }));
jest.mock('@/services/feedService', () => ({ feedService: { getSavedPosts: jest.fn() } }));
jest.mock('@/utils/storage', () => ({
  Storage: { get: jest.fn(async () => null), set: jest.fn(async () => undefined), remove: jest.fn(async () => undefined) },
}));

jest.mock('@/hooks/useSafeBack', () => ({ useSafeBack: () => jest.fn() }));
jest.mock('@/hooks/useDismissKeyboardOnBlur', () => ({ useDismissKeyboardOnBlur: () => undefined }));
jest.mock('@/hooks/useExternalActorResolve', () => ({ useExternalActorResolve: () => null }));
jest.mock('@/hooks/useTrendNavigation', () => ({ useTrendNavigation: () => ({ navigateToTrend: jest.fn() }) }));

jest.mock('@/stores/trendsStore', () => {
  const state = {
    trends: [], hiddenTrendIds: [], isLoading: false, hasFetched: true, error: null,
    fetchTrends: () => undefined, startPolling: () => 'subscription', stopPolling: () => undefined,
  };
  return { useTrendsStore: (select: (value: typeof state) => unknown) => select(state) };
});

jest.mock('@oxy.so/bloom/theme', () => ({
  useTheme: () => ({ colors: new Proxy({}, { get: () => '#000' }) }),
}));

function mockStub(name: string) {
  const { Text: RNText } = jest.requireActual<typeof import('react-native')>('react-native');
  const Stub = (props: { children?: import('react').ReactNode }) => <RNText testID={name}>{props.children ?? null}</RNText>;
  Stub.displayName = name;
  return Stub;
}

jest.mock('@oxy.so/bloom/page-header', () => ({ PageHeader: mockStub('page-header') }));
jest.mock('@oxy.so/bloom/loading', () => ({ Loading: mockStub('loading') }));
jest.mock('@oxy.so/bloom/tabs', () => ({ Tabs: mockStub('tabs'), TabsTrigger: mockStub('tab') }));
jest.mock('@oxy.so/bloom/search', () => {
  const React_ = jest.requireActual<typeof import('react')>('react');
  const { TextInput } = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    Search: React_.forwardRef<unknown, { value: string }>((props, ref) => (
      <TextInput ref={ref as never} value={props.value} testID="search-box" />
    )),
  };
});
jest.mock('@/assets/icons/search-icon', () => ({ Search: mockStub('search-icon') }));
jest.mock('@/components/SEO', () => ({ SEO: () => null }));
jest.mock('@/components/Error', () => ({ Error: mockStub('error') }));
jest.mock('@/components/common/EmptyState', () => ({ EmptyState: mockStub('empty') }));
jest.mock('@/components/trending/TrendItemRow', () => ({ TrendItemRow: mockStub('trend') }));
jest.mock('@/components/search/ExternalActorFollowButton', () => ({ ExternalActorFollowButton: mockStub('follow') }));
jest.mock('@/components/Feed/PostItem', () => {
  const { Text: RNText } = jest.requireActual<typeof import('react-native')>('react-native');
  return { __esModule: true, default: ({ post }: { post: { id: string } }) => <RNText testID={`post-${post.id}`}>{post.id}</RNText> };
});
jest.mock('@/components/ProfileCard', () => {
  const { Text: RNText } = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    ProfileCard: ({ profile }: { profile: { username: string } }) => (
      <RNText testID={`profile-${profile.username}`}>{profile.username}</RNText>
    ),
    ProfileCardSkeletonList: mockStub('profile-skeleton'),
  };
});
jest.mock('@/components/FeedCard', () => ({ FeedCard: mockStub('feed'), FeedCardSkeleton: mockStub('feed-skeleton') }));
jest.mock('@/components/ListCard', () => ({ ListCard: mockStub('list') }));
jest.mock('@/components/StarterPackCard', () => ({
  StarterPackCard: mockStub('pack'),
  StarterPackCardSkeleton: mockStub('pack-skeleton'),
}));

interface MockListProps {
  data: readonly unknown[];
  renderItem: (info: { item: unknown }) => import('react').ReactNode;
  keyExtractor: (item: unknown) => string;
  ListHeaderComponent?: import('react').ReactNode;
}

jest.mock('@shopify/flash-list', () => {
  const React_ = jest.requireActual<typeof import('react')>('react');
  return {
    FlashList: (props: MockListProps) => (
      <>
        {props.ListHeaderComponent}
        {props.data.map((item) => (
          <React_.Fragment key={props.keyExtractor(item)}>{props.renderItem({ item })}</React_.Fragment>
        ))}
      </>
    ),
  };
});

// ── Sources ─────────────────────────────────────────────────────────────────

const PEOPLE: SearchResults = {
  users: [{ id: 'u-1', username: 'rustacean' } as never],
};
const OVERVIEW: SearchResults = {
  hashtags: [{ tag: 'rustlang', count: 12 } as never], feeds: [], lists: [], starterPacks: [],
};
const POSTS: SearchResults = { posts: [{ id: 'p-1' } as never] };

/** The posts source's answer, released by the test. */
let releasePosts: (value: SearchResults) => void = () => undefined;

beforeEach(() => {
  jest.spyOn(searchService, 'getSearchHistory').mockResolvedValue([]);
  jest.spyOn(searchService, 'searchAllSource').mockImplementation((source: SearchAllSource) => {
    switch (source) {
      case 'users': return Promise.resolve(PEOPLE);
      case 'overview': return Promise.resolve(OVERVIEW);
      case 'saved': return Promise.resolve({ saved: [] });
      case 'posts': return new Promise<SearchResults>((resolve) => { releasePosts = resolve; });
    }
  });
});

afterEach(() => {
  jest.restoreAllMocks();
});

async function renderScreen(): Promise<{ renderer: ReactTestRenderer; client: QueryClient }> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <QueryClientProvider client={client}>
        <SearchScreen />
      </QueryClientProvider>,
    );
  });
  await settle();
  return { renderer, client };
}

/** Let resolved sources reach the screen (React Query notifies on a timer tick). */
async function settle(): Promise<void> {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

function has(renderer: ReactTestRenderer, testID: string): boolean {
  return renderer.root.findAll((node) => node.props.testID === testID).length > 0;
}

function text(renderer: ReactTestRenderer): string {
  return renderer.root
    .findAll((node) => typeof node.props.children === 'string')
    .map((node) => node.props.children as string)
    .join(' ');
}

describe('the All search tab', () => {
  it('renders People while the posts search is still pending', async () => {
    const { renderer, client } = await renderScreen();

    expect(has(renderer, 'profile-rustacean')).toBe(true);
    expect(text(renderer)).toContain('People');
    // Hashtags came back with the overview, which did not wait either.
    expect(text(renderer)).toContain('Hashtags');
    // Posts are still on their way: no section yet, no spinner in its place,
    // and the hairline says more is coming.
    expect(has(renderer, 'post-p-1')).toBe(false);
    expect(has(renderer, 'loading')).toBe(false);
    expect(has(renderer, 'search-refreshing')).toBe(true);

    await act(async () => { renderer.unmount(); });
    client.clear();
  });

  it('adds the Posts section when the posts search answers, and drops the hairline', async () => {
    const { renderer, client } = await renderScreen();

    await act(async () => { releasePosts(POSTS); });
    await settle();

    expect(has(renderer, 'post-p-1')).toBe(true);
    expect(has(renderer, 'profile-rustacean')).toBe(true);
    expect(has(renderer, 'search-refreshing')).toBe(false);

    await act(async () => { renderer.unmount(); });
    client.clear();
  });

  it('asks each source on its own, once', async () => {
    const { renderer, client } = await renderScreen();

    const asked = (searchService.searchAllSource as jest.Mock).mock.calls.map(([source]) => source).sort();
    expect(asked).toEqual(['overview', 'posts', 'saved', 'users']);

    await act(async () => { renderer.unmount(); });
    client.clear();
  });
});
