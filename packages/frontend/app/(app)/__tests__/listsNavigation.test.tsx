jest.mock('@/hooks/useSupervisionState', () => ({
  useSupervisionState: () => ({ ready: true, supervised: false, isError: false }),
}));
import type React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

/** The real query and service revalidate when this screen regains focus. */
type AuthState = {
  user: { id: string } | null;
  isAuthResolved: boolean;
  isPrivateApiPending: boolean;
  canUsePrivateApi: boolean;
};

let mockAuth: AuthState;
const mockHttpGet = jest.fn();
const mockHttpPost = jest.fn();
const mockGetFollowing = jest.fn();
let mockFocus: (() => void) | undefined;

jest.mock('@oxy.so/services/ui/client', () => {
  const { Text: MockText } = jest.requireActual('react-native');
  return {
    OxyAuthPrompt: ({ label }: { label: string }) => (
      <MockText testID="auth-prompt">{label}</MockText>
    ),
    useAuth: () => mockAuth,
  };
});
jest.mock('@oxy.so/bloom/button', () => {
  const { Text: MockText } = jest.requireActual('react-native');
  return {
    Button: ({ children }: { children: React.ReactNode }) => (
      <MockText testID="header-new">{children}</MockText>
    ),
  };
});
jest.mock('@oxy.so/bloom/page-header', () => {
  const { View: MockView } = jest.requireActual('react-native');
  return {
    PageHeader: ({ actions }: { actions?: React.ReactNode }) => <MockView>{actions}</MockView>,
  };
});
jest.mock('@oxy.so/bloom/loading', () => ({ Loading: () => null }));
jest.mock('@/utils/api', () => ({
  authenticatedClient: {
    get: (...args: unknown[]) => mockHttpGet(...args),
    post: (...args: unknown[]) => mockHttpPost(...args),
  },
}));
jest.mock('@oxy.so/core/logger', () => ({ createLogger: () => ({ warn: jest.fn() }) }));
jest.mock('@/services/entityFollowService', () => ({
  entityFollowService: { getFollowing: (...args: unknown[]) => mockGetFollowing(...args) },
}));
jest.mock('@/services/listMutations', () => ({ subscribeToListChanges: () => () => {} }));
jest.mock('expo-router', () => ({
  useRouter: () => jest.requireMock('expo-router').router,
  router: { push: jest.fn() },
  useFocusEffect: (fn: () => void) => {
    mockFocus = fn;
    jest.requireActual<typeof import('react')>('react').useEffect(fn, [fn]);
  },
}));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
  }),
}));
jest.mock('@/components/SEO', () => ({ SEO: () => null }));
jest.mock('@/components/ListCard', () => {
  const { Text } = jest.requireActual('react-native');
  return {
    ListCard: ({ list }: { list: { id: string } }) => (
      <Text testID={`list-${list.id}`}>{list.id}</Text>
    ),
  };
});
jest.mock('@/components/common/EmptyState', () => {
  const { Text: MockText } = jest.requireActual('react-native');
  return {
    EmptyState: ({ action }: { action?: { label: string } }) =>
      action ? <MockText testID="empty-create">{action.label}</MockText> : null,
  };
});

import ListsScreen from '../lists';

let mounted: TestRenderer.ReactTestRenderer | undefined;
let client: QueryClient;

afterEach(async () => {
  await act(async () => mounted?.unmount());
  client?.clear();
  mounted = undefined;
});

async function render(): Promise<TestRenderer.ReactTestRenderer> {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let tree!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    tree = mounted = TestRenderer.create(
      <QueryClientProvider client={client}>
        <ListsScreen />
      </QueryClientProvider>,
    );
  });
  return tree;
}

async function settleQueries() {
  for (let attempt = 0; attempt < 25; attempt++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    if (client.isFetching() === 0) return;
  }
  throw new Error('Queries did not settle');
}

it('revalidates followed lists on return with one batched resolution', async () => {
  mockAuth = {
    user: { id: 'viewer-1' },
    isAuthResolved: true,
    isPrivateApiPending: false,
    canUsePrivateApi: true,
  };
  mockHttpGet.mockResolvedValue({ data: { items: [] } });
  mockGetFollowing.mockResolvedValue({
    items: Array.from({ length: 10 }, (_, i) => ({ entityId: `list-${i}` })),
  });
  mockHttpPost.mockImplementation(async (_url: string, { ids }: { ids: string[] }) => ({
    data: { items: ids.map((id) => ({ id, title: id })) },
  }));
  const tree = await render();
  await settleQueries();
  expect(mockGetFollowing).toHaveBeenCalledTimes(1);
  expect(mockGetFollowing).toHaveBeenCalledWith('list', 50);
  expect(mockHttpPost).toHaveBeenCalledTimes(1);
  expect(mockHttpGet).toHaveBeenCalledTimes(1); // own lists only
  const listNodes = (id: string) =>
    tree.root.findAll(
      (node) => typeof node.type === 'string' && node.props.testID === `list-${id}`,
    );
  const waitForList = async (id: string) => {
    for (let attempt = 0; attempt < 25 && listNodes(id).length === 0; attempt++) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
  };
  await waitForList('list-0');
  expect(listNodes('list-0')).toHaveLength(1);
  await act(async () => {
    mockFocus?.();
  });
  await settleQueries();
  expect(mockGetFollowing).toHaveBeenCalledTimes(2);
  expect(mockHttpPost).toHaveBeenCalledTimes(2);
  expect(mockHttpGet).toHaveBeenCalledTimes(1);
  mockGetFollowing.mockResolvedValue({ items: [{ entityId: 'new' }] });
  await act(async () => {
    mockFocus?.();
  });
  await settleQueries();
  expect(mockGetFollowing).toHaveBeenCalledTimes(3);
  expect(mockHttpPost).toHaveBeenCalledTimes(3);
  expect(mockHttpGet).toHaveBeenCalledTimes(1);
  await waitForList('new');
  expect(listNodes('new')).toHaveLength(1);
  expect(listNodes('list-0')).toHaveLength(0);

  // The old per-list requests omitted every item on 401. A failed batch must
  // clear already visible data as well, without issuing individual reads.
  mockHttpPost.mockRejectedValueOnce({ status: 401 });
  await act(async () => mockFocus?.());
  await settleQueries();
  for (let attempt = 0; attempt < 25 && listNodes('new').length > 0; attempt++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
  expect(listNodes('new')).toHaveLength(0);
  expect(mockHttpGet).toHaveBeenCalledTimes(1);

  // A late answer for the previous viewer cannot populate the new viewer's
  // query, even if it arrives after the account transition.
  let resolveOld!: (value: unknown) => void;
  mockHttpPost.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveOld = resolve;
      }),
  );
  await act(async () => mockFocus?.());
  expect(resolveOld).toBeDefined();
  mockAuth = { ...mockAuth, user: { id: 'viewer-2' } };
  mockGetFollowing.mockResolvedValue({ items: [{ entityId: 'viewer-2-list' }] });
  await act(async () => {
    tree.update(
      <QueryClientProvider client={client}>
        <ListsScreen />
      </QueryClientProvider>,
    );
  });
  await waitForList('viewer-2-list');
  expect(listNodes('viewer-2-list')).toHaveLength(1);
  await act(async () =>
    resolveOld({ data: { items: [{ id: 'stale-viewer-1', title: 'stale' }] } }),
  );
  await settleQueries();
  expect(listNodes('viewer-2-list')).toHaveLength(1);
  expect(listNodes('stale-viewer-1')).toHaveLength(0);
});
