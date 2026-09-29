import React from 'react';
import { Text, View } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

/**
 * Followers / Following for a handle that has no account.
 *
 * OxyHQ/Mention#1124, reproduced on production web: `/@qa_missing/followers`
 * got a 404 from the profile lookup, the title said "Profile not found", and the
 * body kept eight loading skeletons forever — the list's own `loading` flag
 * started `true` and only a fetch could clear it, but it never fetched without
 * a profile id.
 */

type ProfileState = {
  data: { id: string; username: string; design: { displayName: string } } | null;
  loading: boolean;
  error: boolean;
  notFound: boolean;
  refresh: jest.Mock;
};

let mockProfile: ProfileState;
const mockGetUserFollowers = jest.fn();
const mockGetUserFollowing = jest.fn();
const mockSafeBack = jest.fn();
let mockPathname = '/@qa_missing/followers';

jest.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ username: '@qa_missing' }),
  usePathname: () => mockPathname,
  router: { push: jest.fn() },
}));
jest.mock('@/hooks/useSafeBack', () => ({ useSafeBack: () => mockSafeBack }));
jest.mock('@/hooks/useProfileData', () => ({ useProfileData: () => mockProfile }));
jest.mock('@/hooks/useProfileScreenColor', () => ({ useProfileScreenColor: () => ({ colorName: undefined }) }));
jest.mock('@/hooks/useRecommendations', () => ({
  useRecommendations: () => ({
    recommendations: [],
    isError: false,
    error: null,
    isLoading: false,
    isFetching: false,
    refetch: jest.fn(),
  }),
}));
jest.mock('@oxy.so/services/ui/client', () => ({
  useAuth: () => ({
    user: { id: 'viewer-1', username: 'viewer', name: { displayName: 'Viewer' } },
    oxyServices: {
      follows: {
        followers: mockGetUserFollowers,
        following: mockGetUserFollowing,
        mutuals: jest.fn(async () => ({ mutuals: [] })),
      },
    },
  }),
}));
jest.mock('@oxy.so/core', () => ({
  getNormalizedUserHandle: ({ username }: { username?: string }) => username,
}));
jest.mock('@oxy.so/core/logger', () => ({ logger: { warn: jest.fn(), error: jest.fn() } }));
jest.mock('@/lib/actorCache', () => ({ cacheActors: jest.fn() }));
jest.mock('@/utils/authErrors', () => ({ isAuthError: () => false }));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
  }),
}));

jest.mock('@/components/ProfileCard', () => {
  const { Text: RNText, View: RNView } = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    ProfileCard: ({ profile }: { profile: { username: string } }) => <RNText>{`row:${profile.username}`}</RNText>,
    ProfileCardSkeletonList: () => <RNView testID="connections-skeletons" />,
  };
});
jest.mock('@/components/common/EmptyState', () => {
  const { Pressable, Text: RNText, View: RNView } = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    // Two empty states share this component: the missing profile (sticker
    // `profileNotFound`) and an empty list, told apart by the sticker.
    EmptyState: ({ title, action, error, sticker }: {
      title?: string;
      action?: { label: string; onPress: () => void };
      error?: { message: string; onRetry?: () => Promise<void> };
      sticker?: string;
    }) => error ? (
      <Pressable testID="connections-error" onPress={() => { void error.onRetry?.(); }}>
        <RNText>{error.message}</RNText>
      </Pressable>
    ) : sticker !== 'profileNotFound' ? (
      <RNView testID="connections-empty" accessibilityHint={sticker}>
        <RNText>{title}</RNText>
      </RNView>
    ) : (
      <RNView testID="profile-not-found">
        <RNText>{title}</RNText>
        {action ? <Pressable testID="not-found-back" onPress={action.onPress}><RNText>{action.label}</RNText></Pressable> : null}
      </RNView>
    ),
  };
});
jest.mock('@/assets/illustrations/NoUpdates', () => ({ NoUpdatesIllustration: () => null }));
jest.mock('@/components/Error', () => {
  const { Pressable, Text: RNText } = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    Error: ({ message, onRetry }: { message: string; onRetry: () => void }) => (
      <Pressable testID="connections-error" onPress={onRetry}><RNText>{message}</RNText></Pressable>
    ),
  };
});
jest.mock('@oxy.so/bloom/page-header', () => ({ PageHeader: () => null }));
jest.mock('@oxy.so/bloom/typography', () => {
  const { Text: RNText } = jest.requireActual<typeof import('react-native')>('react-native');
  return { Text: RNText };
});
jest.mock('@oxy.so/bloom/icons/RiArrowRightSLine', () => ({ RiArrowRightSLine: () => null }));
jest.mock('@oxy.so/bloom/icons/RiGroupFill', () => ({ RiGroupFill: () => null }));
jest.mock('@oxy.so/bloom/icons/RiGroupLine', () => ({ RiGroupLine: () => null }));
jest.mock('@oxy.so/bloom/tabs', () => ({ Tabs: () => null, TabsTrigger: () => null }));
jest.mock('@oxy.so/bloom/theme', () => ({
  BloomColorScope: ({ children }: { children: React.ReactNode }) => children,
  useTheme: () => ({ colors: { card: '#fff', textSecondary: '#666' } }),
}));
jest.mock('@oxy.so/bloom/list', () => {
  const { Text: RNText, View: RNView } = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    VirtualList: ({ data, renderItem, ListEmptyComponent }: {
      data: unknown[];
      renderItem: (info: { item: unknown }) => React.ReactNode;
      ListEmptyComponent: React.ReactNode;
    }) => (
      <RNView testID="connections-list">
        {data.length === 0 ? ListEmptyComponent : data.map((item, i) => <RNView key={i}>{renderItem({ item })}</RNView>)}
        <RNText>{`count:${data.length}`}</RNText>
      </RNView>
    ),
  };
});

import ConnectionsScreen from '../connections';

const byTestId = (tree: TestRenderer.ReactTestRenderer, testID: string) =>
  tree.root.findAll((node) => node.props.testID === testID && typeof node.type === 'string');

const texts = (tree: TestRenderer.ReactTestRenderer) =>
  tree.root.findAllByType(Text).flatMap((node) => node.props.children).filter((c) => typeof c === 'string');

let mounted: TestRenderer.ReactTestRenderer | null = null;

async function renderScreen() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let tree!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    tree = TestRenderer.create(
      <QueryClientProvider client={client}>
        <View><ConnectionsScreen /></View>
      </QueryClientProvider>,
    );
  });
  // Let any enabled query resolve and re-render.
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
  mounted = tree;
  return tree;
}

afterEach(() => {
  if (mounted) act(() => mounted!.unmount());
  mounted = null;
});

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  jest.clearAllMocks();
  mockPathname = '/@qa_missing/followers';
  mockGetUserFollowers.mockResolvedValue({ followers: [] });
  mockGetUserFollowing.mockResolvedValue({ following: [] });
});

describe.each(['followers', 'following'])('the %s route', (tab) => {
  beforeEach(() => {
    mockPathname = `/@qa_missing/${tab}`;
  });

  it('ends loading on a definitive 404 and offers a way back', async () => {
    mockProfile = { data: null, loading: false, error: true, notFound: true, refresh: jest.fn() };
    const tree = await renderScreen();

    expect(byTestId(tree, 'connections-skeletons')).toHaveLength(0);
    expect(byTestId(tree, 'profile-not-found')).toHaveLength(1);
    expect(texts(tree)).toContain('Profile not found');

    act(() => byTestId(tree, 'not-found-back')[0].props.onClick?.() ?? byTestId(tree, 'not-found-back')[0].props.onPress?.());
    expect(mockSafeBack).toHaveBeenCalled();
    expect(mockGetUserFollowers).not.toHaveBeenCalled();
    expect(mockGetUserFollowing).not.toHaveBeenCalled();
  });

  it('offers a retry, not "not found", when the lookup failed', async () => {
    const refresh = jest.fn(async () => undefined);
    mockProfile = { data: null, loading: false, error: true, notFound: false, refresh };
    const tree = await renderScreen();

    expect(byTestId(tree, 'connections-skeletons')).toHaveLength(0);
    expect(byTestId(tree, 'profile-not-found')).toHaveLength(0);
    const error = byTestId(tree, 'connections-error');
    expect(error).toHaveLength(1);

    act(() => error[0].props.onClick?.() ?? error[0].props.onPress?.());
    expect(refresh).toHaveBeenCalled();
  });

  it('keeps the skeletons only while the profile is still being looked up', async () => {
    mockProfile = { data: null, loading: true, error: false, notFound: false, refresh: jest.fn() };
    const tree = await renderScreen();

    expect(byTestId(tree, 'connections-skeletons')).toHaveLength(1);
  });

  it('shows the empty state for a real profile with no connections', async () => {
    mockProfile = {
      data: { id: 'profile-1', username: 'qa_missing', design: { displayName: 'QA' } },
      loading: false,
      error: false,
      notFound: false,
      refresh: jest.fn(),
    };
    const tree = await renderScreen();

    expect(byTestId(tree, 'connections-skeletons')).toHaveLength(0);
    expect(byTestId(tree, 'profile-not-found')).toHaveLength(0);
    expect(texts(tree)).toContain('count:0');
    expect(texts(tree)).toContain(tab === 'followers' ? 'No followers yet' : 'Not following anyone yet');
    const empty = byTestId(tree, 'connections-empty');
    expect(empty).toHaveLength(1);
    expect(empty[0].props.accessibilityHint).toBe(tab === 'followers' ? 'connectionsFollowers' : 'connectionsFollowing');
  });
});

it('lists the rows a real profile has', async () => {
  mockProfile = {
    data: { id: 'profile-1', username: 'someone', design: { displayName: 'Someone' } },
    loading: false,
    error: false,
    notFound: false,
    refresh: jest.fn(),
  };
  mockGetUserFollowers.mockResolvedValue({ followers: [{ id: 'u1', username: 'alice' }] });
  const tree = await renderScreen();

  expect(mockGetUserFollowers).toHaveBeenCalledWith('profile-1');
  expect(texts(tree)).toContain('row:alice');
});
