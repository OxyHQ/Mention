import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

/**
 * Lists offered a signed-out reader "+ New" and "Create list", and the form
 * behind them could only fail (#1126, item 8). Signed out, the screen now shows
 * the sign-in prompt and no create entry point, and makes no private read.
 *
 * The mocks stop at module boundaries: Bloom and the SDK barrel cannot be
 * required under jest, and React Query is real because whether the owned-lists
 * read fires is part of what is asserted.
 */

type AuthState = {
  user: { id: string } | null;
  isAuthResolved: boolean;
  isPrivateApiPending: boolean;
  canUsePrivateApi: boolean;
};

let mockAuth: AuthState;
const mockListLists = jest.fn();

jest.mock('@oxy.so/services/ui/client', () => {
  const { Text: MockText } = jest.requireActual('react-native');
  return {
    OxyAuthPrompt: ({ label }: { label: string }) => <MockText testID="auth-prompt">{label}</MockText>,
    useAuth: () => mockAuth,
  };
});
jest.mock('@oxy.so/bloom/button', () => {
  const { Text: MockText } = jest.requireActual('react-native');
  return { Button: ({ children }: { children: React.ReactNode }) => <MockText testID="header-new">{children}</MockText> };
});
jest.mock('@oxy.so/bloom/page-header', () => {
  const { View: MockView } = jest.requireActual('react-native');
  return { PageHeader: ({ actions }: { actions?: React.ReactNode }) => <MockView>{actions}</MockView> };
});
jest.mock('@oxy.so/bloom/loading', () => ({ Loading: () => null }));
jest.mock('@/services/listsService', () => ({
  listsService: {
    list: (...args: unknown[]) => mockListLists(...args),
    get: jest.fn(),
  },
}));
jest.mock('@/services/entityFollowService', () => ({
  entityFollowService: { getFollowing: jest.fn().mockResolvedValue({ items: [] }) },
}));
jest.mock('@/services/listMutations', () => ({ subscribeToListChanges: () => () => {} }));
jest.mock('expo-router', () => ({ router: { push: jest.fn() }, useFocusEffect: () => {} }));
jest.mock('@/hooks/useSafeBack', () => ({ useSafeBack: () => jest.fn() }));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
  }),
}));
jest.mock('@/components/SEO', () => ({ SEO: () => null }));
jest.mock('@/components/ListCard', () => ({ ListCard: () => null }));
jest.mock('@/components/common/EmptyState', () => {
  const { Text: MockText } = jest.requireActual('react-native');
  return {
    EmptyState: ({ action }: { action?: { label: string } }) =>
      action ? <MockText testID="empty-create">{action.label}</MockText> : null,
  };
});
jest.mock('@/assets/icons/list-icon', () => ({ List: () => null }));
jest.mock('@/components/common/FocusedScrollView', () => {
  const { View: MockView } = jest.requireActual('react-native');
  return { FocusedScrollView: ({ children }: { children: React.ReactNode }) => <MockView>{children}</MockView> };
});
jest.mock('@/context/ScreenReselectContext', () => ({ useScreenReselect: () => {} }));

import ListsScreen from '../lists';

let mounted: TestRenderer.ReactTestRenderer | undefined;

async function render(): Promise<TestRenderer.ReactTestRenderer> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
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

const has = (tree: TestRenderer.ReactTestRenderer, testID: string) =>
  tree.root.findAll((node) => typeof node.type === 'string' && node.props.testID === testID).length > 0;

describe('Lists screen, signed out', () => {
  beforeEach(() => {
    mockListLists.mockReset().mockResolvedValue({ items: [] });
  });

  // Unmounted inside `act` so a read that settles after the assertions cannot
  // render into a torn-down environment.
  afterEach(async () => {
    await act(async () => {
      mounted?.unmount();
    });
    mounted = undefined;
  });

  it('shows the sign-in prompt and no way into the create form', async () => {
    mockAuth = { user: null, isAuthResolved: true, isPrivateApiPending: false, canUsePrivateApi: false };
    const tree = await render();

    expect(has(tree, 'auth-prompt')).toBe(true);
    expect(has(tree, 'header-new')).toBe(false);
    expect(has(tree, 'empty-create')).toBe(false);
    expect(mockListLists).not.toHaveBeenCalled();
  });

  it('offers both create entry points once the private API is usable', async () => {
    mockAuth = { user: { id: 'viewer-1' }, isAuthResolved: true, isPrivateApiPending: false, canUsePrivateApi: true };
    const tree = await render();

    expect(has(tree, 'auth-prompt')).toBe(false);
    expect(has(tree, 'header-new')).toBe(true);
    expect(has(tree, 'empty-create')).toBe(true);
    expect(mockListLists).toHaveBeenCalledWith({ mine: true });
  });
});
