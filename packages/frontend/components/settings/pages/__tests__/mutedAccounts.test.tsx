import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import MutedAccountsScreen from '../privacy/muted-accounts';

const mockGetMutedUsers = jest.fn();
const mockUnmuteUser = jest.fn();
const mockGetMany = jest.fn();
const mockToast = jest.fn();

jest.mock('@/services/muteService', () => ({
  muteService: {
    getMutedUsers: () => mockGetMutedUsers(),
    unmuteUser: (...args: unknown[]) => mockUnmuteUser(...args),
  },
}));
jest.mock('@oxy.so/services/ui/client', () => ({
  OxyAuthPrompt: () => null,
  useAuth: () => ({
    isAuthenticated: true,
    canUsePrivateApi: true,
    user: { id: 'viewer' },
    oxyServices: { users: { getMany: mockGetMany } },
  }),
}));
jest.mock('@oxy.so/bloom/toast', () => ({ toast: (...args: unknown[]) => mockToast(...args) }));
jest.mock('@oxy.so/bloom/admonition', () => ({ Admonition: () => null }));
jest.mock('@oxy.so/bloom/settings-modal', () => ({
  SettingsSection: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock('@oxy.so/bloom/grouped-section', () => ({
  GroupedSection: ({ children }: { children: React.ReactNode }) => children,
  GroupedSectionItem: ({
    title,
    rightElement,
  }: {
    title: string;
    rightElement: React.ReactNode;
  }) => {
    const { View, Text } = require('react-native');
    return (
      <View>
        <Text>{title}</Text>
        {rightElement}
      </View>
    );
  },
}));
jest.mock('@oxy.so/bloom/button', () => ({
  Button: ({
    onPress,
    accessibilityLabel,
  }: {
    onPress: () => void;
    accessibilityLabel: string;
  }) => {
    const { Pressable } = require('react-native');
    return <Pressable testID="unmute" accessibilityLabel={accessibilityLabel} onPress={onPress} />;
  },
}));
jest.mock('@/components/common/EmptyState', () => ({
  EmptyState: ({ title }: { title: string }) => {
    const { Text } = require('react-native');
    return <Text>{title}</Text>;
  },
}));
jest.mock('@/components/loading/ContentSkeleton', () => ({ ListSkeleton: () => null }));
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

describe('muted accounts', () => {
  let tree: ReactTestRenderer;
  let client: QueryClient;

  const settle = async () => {
    for (let i = 0; i < 5; i += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
  };
  const render = async () => {
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    act(() => {
      tree = create(
        <QueryClientProvider client={client}>
          <MutedAccountsScreen />
        </QueryClientProvider>,
      );
    });
    await settle();
  };
  const output = () => JSON.stringify(tree.toJSON());

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetMutedUsers.mockResolvedValue([{ mutedId: 'a' }, { mutedId: 'gone' }]);
    mockGetMany.mockResolvedValue([{ id: 'a', username: 'ada', name: { displayName: 'Ada' } }]);
    mockUnmuteUser.mockResolvedValue(true);
  });
  afterEach(() => {
    act(() => tree.unmount());
    client.clear();
  });

  it('lists every mute, including an account Oxy no longer resolves', async () => {
    await render();
    expect(output()).toContain('Ada');
    expect(output()).toContain('settings.privacy.mutedAccounts.unknown');
  });

  it('unmutes the chosen account and reads the list again', async () => {
    await render();
    mockGetMutedUsers.mockResolvedValue([]);
    await act(async () => {
      tree.root.findAll((node) => node.props.testID === 'unmute')[0].props.onPress();
    });
    await settle();
    expect(mockUnmuteUser).toHaveBeenCalledWith('a', 'viewer');
    expect(output()).toContain('settings.privacy.mutedAccounts.empty');
  });

  it('says so when unmuting fails', async () => {
    mockUnmuteUser.mockResolvedValue(false);
    await render();
    await act(async () => {
      tree.root.findAll((node) => node.props.testID === 'unmute')[0].props.onPress();
    });
    await settle();
    expect(mockToast).toHaveBeenCalledWith('settings.privacy.mutedAccounts.unmuteFailed', {
      type: 'error',
    });
  });

  it('shows a failed read as a failure, not an empty list', async () => {
    mockGetMutedUsers.mockRejectedValue(new Error('offline'));
    await render();
    expect(output()).toContain('settings.privacy.mutedAccounts.loadFailed');
    expect(output()).not.toContain('settings.privacy.mutedAccounts.empty');
  });
});
