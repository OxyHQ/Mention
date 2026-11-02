import type React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const mockGet = jest.fn();
let mockAuth = {
  isAuthResolved: false,
  isPrivateApiPending: true,
  canUsePrivateApi: false,
  user: null as { id: string } | null,
};

jest.mock('@oxy.so/services/ui/client', () => {
  const { Text } = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    useAuth: () => mockAuth,
    OxyAuthPrompt: ({ label }: { label: string }) => <Text testID="auth-prompt">{label}</Text>,
  };
});
jest.mock('@/components/SupervisedFeatureGate', () => ({
  SupervisedFeatureGate: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock('@/components/loading/ContentSkeleton', () => ({
  DetailSkeleton: () => null,
  FormSkeleton: () => null,
}));
jest.mock('@oxy.so/bloom/page-header', () => ({ PageHeader: () => null }));
jest.mock('@oxy.so/bloom/button', () => ({ Button: () => null }));
jest.mock('@oxy.so/bloom/avatar', () => ({ Avatar: () => null }));
jest.mock('@oxy.so/bloom/tabs', () => ({ Tabs: () => null, TabsTrigger: () => null }));
jest.mock('@oxy.so/bloom/theme', () => ({ useTheme: () => ({ colors: {} }) }));
jest.mock('@/components/ProfileCard', () => ({
  ProfileCard: () => null,
  ProfileCardSkeletonList: () => null,
}));
jest.mock('@/components/Feed/Feed', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/EntityFollowButton', () => ({ EntityFollowButton: () => null }));
jest.mock('@/components/ProfileHoverCard', () => ({ ProfileHoverCard: () => null }));
jest.mock('@/components/common/EmptyState', () => ({ EmptyState: () => null }));
jest.mock('@/services/listsService', () => ({
  listsService: { get: (...args: unknown[]) => mockGet(...args) },
}));
jest.mock('@/services/listMutations', () => ({ subscribeToListChanges: () => () => {} }));
jest.mock('@/lib/navigation/router', () => ({
  useRouter: () => ({ push: jest.fn(), back: jest.fn() }),
  useLocalSearchParams: () => ({ id: 'public-list' }),
}));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
  }),
}));

import AvailableListDetailScreen from '../lists/[id]';

test('waits for a usable session before reading list details, and loads after sign-in', async () => {
  mockGet.mockReturnValue(new Promise(() => {}));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const screen = () => (
    <QueryClientProvider client={client}>
      <AvailableListDetailScreen />
    </QueryClientProvider>
  );
  const renderers: TestRenderer.ReactTestRenderer[] = [];
  await act(async () => {
    renderers.push(TestRenderer.create(screen()));
  });
  const renderer = renderers[0];
  if (!renderer) throw new Error('List detail did not render');
  expect(renderer.root.findAllByProps({ testID: 'sign-in-required-pending' })).not.toHaveLength(0);
  expect(mockGet).not.toHaveBeenCalled();

  mockAuth = { ...mockAuth, isAuthResolved: true, isPrivateApiPending: false };
  await act(async () => {
    renderer.update(screen());
  });
  expect(renderer.root.findAllByProps({ testID: 'auth-prompt' })).not.toHaveLength(0);
  expect(mockGet).not.toHaveBeenCalled();

  mockAuth = { ...mockAuth, canUsePrivateApi: true, user: { id: 'viewer' } };
  await act(async () => {
    renderer.update(screen());
  });
  expect(mockGet).toHaveBeenCalledWith('public-list');
  await act(async () => renderer.unmount());
  client.clear();
});
