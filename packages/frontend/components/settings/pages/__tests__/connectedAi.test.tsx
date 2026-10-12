import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import ConnectedAiScreen from '../connected-ai';

/**
 * Settings → Connected AI lists the AI connectors authorized for THIS
 * deployment's MCP server, and revokes them.
 *
 * Oxy is the authority: it authorizes every connector, for every app, so the
 * screen asks it for the account's connectors and keeps those bound to Mention's
 * MCP resource. The connections Mention used to keep itself were retired with
 * its own OAuth authority (2026-10-02); listing them showed connectors that
 * could no longer do anything.
 */

const mockConnected = {
  mcpClients: jest.fn(),
  revokeMcpClient: jest.fn(),
};

jest.mock('@oxy.so/services/ui/client', () => {
  const { Text } = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    useAuth: () => ({
      user: { id: 'viewer-1' },
      oxyServices: { apps: { connected: mockConnected } },
      isAuthResolved: true,
      canUsePrivateApi: true,
      isPrivateApiPending: false,
    }),
    OxyAuthPrompt: ({ label }: { label?: string }) => <Text>{label}</Text>,
  };
});

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, string> & { defaultValue?: string }) =>
      (vars?.defaultValue ?? key).replace(/\{\{(\w+)\}\}/g, (_m, name: string) =>
        String(vars?.[name] ?? ''),
      ),
  }),
}));

jest.mock('@oxy.so/bloom/settings-modal', () => {
  const { View, Text } = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    SettingsCard: View,
    SettingsSection: View,
    SettingsRow: ({ label, children }: { label: string; children?: React.ReactNode }) => (
      <View>
        <Text>{label}</Text>
        {children}
      </View>
    ),
  };
});
jest.mock('@oxy.so/bloom/button', () => {
  const { Text, TouchableOpacity } =
    jest.requireActual<typeof import('react-native')>('react-native');
  return {
    Button: ({ children, onPress }: { children: React.ReactNode; onPress?: () => void }) => (
      <TouchableOpacity accessibilityRole="button" onPress={onPress}>
        <Text>{children}</Text>
      </TouchableOpacity>
    ),
  };
});
jest.mock('@oxy.so/bloom/loading', () => {
  const { View } = jest.requireActual<typeof import('react-native')>('react-native');
  return { Loading: () => <View testID="spinner" /> };
});
jest.mock('@oxy.so/bloom/icon-circle', () => ({ IconCircle: () => null }));
jest.mock('@oxy.so/bloom/icons/RiSparklingLine', () => ({ RiSparklingLine: () => null }));
jest.mock('@oxy.so/bloom/toast', () => ({ toast: jest.fn() }));
jest.mock('@/components/common/EmptyState', () => ({ EmptyState: () => null }));
jest.mock('@/utils/alerts', () => ({ confirmDialog: jest.fn(async () => true) }));

const MENTION = {
  appSlug: 'mention',
  resource: 'https://mcp.mention.earth',
  scopes: ['social.read'],
  createdAt: '2026-10-01T10:00:00.000Z',
  lastUsedAt: '2026-10-02T10:00:00.000Z',
};

function texts(renderer: TestRenderer.ReactTestRenderer): string[] {
  return renderer.root
    .findAll((node) => String(node.type) === 'Text')
    .map((node) => [node.props.children].flat().join(''));
}

let mounted: { renderer: TestRenderer.ReactTestRenderer; queryClient: QueryClient } | undefined;

async function render(): Promise<TestRenderer.ReactTestRenderer> {
  // No retries and no garbage-collection timer: nothing may still be running
  // once a test has finished.
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <QueryClientProvider client={queryClient}>
        <ConnectedAiScreen />
      </QueryClientProvider>,
    );
  });
  // Let the Oxy query settle.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  mounted = { renderer, queryClient };
  return renderer;
}

afterEach(async () => {
  if (!mounted) return;
  const { renderer, queryClient } = mounted;
  mounted = undefined;
  await act(async () => {
    renderer.unmount();
  });
  queryClient.clear();
});

describe('Connected AI settings', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockConnected.mcpClients.mockResolvedValue([
      { ...MENTION, id: 'grant-claude', clientId: 'claude', clientName: 'Claude' },
      { ...MENTION, id: 'grant-cursor', clientId: 'cursor', clientName: '' },
      {
        ...MENTION,
        id: 'grant-other-app',
        resource: 'https://mcp.other.example',
        clientId: 'claude',
        clientName: 'Claude for Other',
      },
    ]);
    mockConnected.revokeMcpClient.mockResolvedValue(undefined);
  });

  it('lists only the connectors that can act on Mention', async () => {
    const shown = texts(await render());

    expect(shown).toContain('Claude');
    expect(shown).toContain('Cursor');
    expect(shown).not.toContain('Claude for Other');
  });

  it('revokes a connector through Oxy', async () => {
    const renderer = await render();
    const revoke = renderer.root.findAll(
      (node) =>
        node.props.accessibilityRole === 'button' && typeof node.props.onPress === 'function',
    )[0];

    await act(async () => {
      await revoke.props.onPress();
    });
    // The revoke invalidates the list; let that refetch finish inside the test.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(mockConnected.revokeMcpClient).toHaveBeenCalledWith('grant-claude');
  });
});
