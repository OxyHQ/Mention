import React from 'react';
import { TextInput, TouchableOpacity, View } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { muteWordsService, type SerializedMuteWord } from '@/services/muteWordsService';
import HiddenWordsScreen from '@/components/settings/pages/privacy/hidden-words';

/**
 * The muted-words screen must REPORT every change it lands, and only the ones it
 * lands.
 *
 * This is the join between the two halves of the fix, and the one place a
 * regression would be completely silent: `useFeedState` keeps honouring the
 * signal perfectly, the screen simply stops sending it, and every feed goes back
 * to needing a reload. The read side is driven directly in
 * `hooks/__tests__/safetyFilterRevalidation.test.tsx`, so nothing there can catch
 * this — hence the real screen, its real mutations, and a spy on the one
 * authority they are supposed to call.
 *
 * Mocks stop at the module boundary: the HTTP service, the invalidation
 * authority, and the SDK/Bloom packages that ship untranspiled TS. The screen's
 * mutations and their success/error branches are real.
 */

const mockInvalidate = jest.fn();
const mockConfirm = jest.fn();
jest.mock('@oxy.so/bloom/surfaces', () => ({ confirm: (...args: unknown[]) => mockConfirm(...args) }));

jest.mock('@/stores/safetyInvalidation', () => ({
  invalidateSafetyFilters: (...args: unknown[]) => mockInvalidate(...args),
}));

jest.mock('@/services/muteWordsService', () => ({
  muteWordsService: {
    list: jest.fn(),
    create: jest.fn(),
    remove: jest.fn(),
  },
  isHashtagMuteWord: (word: { targets: string[] }) =>
    word.targets.length === 1 && word.targets[0] === 'tag',
  muteWordDisplayValue: (word: { value: string }) => word.value,
}));

// `t` returns the key so every accessibility label queried below is exact and
// independent of the translation catalogue.
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

jest.mock('@oxy.so/bloom/theme', () => ({
  useTheme: () => ({
    isDark: false,
    colors: {
      primary: '#0000ff',
      error: '#ff0000',
      text: '#000000',
      textSecondary: '#666666',
      border: '#cccccc',
      background: '#ffffff',
      card: '#ffffff',
    },
  }),
}));

jest.mock('@oxy.so/bloom/loading', () => {
  const { View: RNView } = jest.requireActual<typeof import('react-native')>('react-native');
  return { Loading: () => <RNView /> };
});

jest.mock('@oxy.so/bloom/toast', () => ({ toast: jest.fn() }));

// Ships untranspiled TS, and is reached only through `BottomSheetContext`'s
// provider — which this file replaces with its own.
jest.mock('@oxy.so/bloom/bottom-sheet', () => ({ BottomSheet: () => null }));

jest.mock('@oxy.so/bloom/settings-modal', () => {
  const { View } = jest.requireActual('react-native');
  return { SettingsCard: View, SettingsSection: View, SettingsRow: View };
});
jest.mock('@oxy.so/bloom/button', () => {
  const { TouchableOpacity } = jest.requireActual('react-native');
  return { Button: TouchableOpacity };
});
jest.mock('@oxy.so/bloom/text-field', () => {
  const { TextInput } = jest.requireActual('react-native');
  return { TextFieldInput: ({ onValueChange, ...props }: { onValueChange: (value: string) => void }) => <TextInput {...props} onChangeText={onValueChange} /> };
});

jest.mock('@oxy.so/services/ui/client', () => ({
  useAuth: () => ({ isAuthenticated: true, user: { id: 'viewer-1' }, canUsePrivateApi: true }),
  OxyAuthPrompt: () => null,
}));

jest.mock('@oxy.so/bloom/page-header', () => ({ PageHeader: () => null }));
jest.mock('@oxy.so/bloom/admonition', () => ({ Admonition: () => null }));
jest.mock('@/components/common/EmptyState', () => ({ EmptyState: () => null }));
jest.mock('@/components/common/ConfirmBottomSheet', () => ({ ConfirmBottomSheet: () => null }));
jest.mock('@/context/MentionSettingsContext', () => ({ useSettingsBack: () => jest.fn() }));

jest.mock('@oxy.so/core/logger', () => ({
  ...jest.requireActual('@oxy.so/core/logger'),
  createLogger: () => ({ debug: jest.fn(), error: jest.fn(), warn: jest.fn(), info: jest.fn() }),
}));

const listMock = muteWordsService.list as jest.Mock;
const createMock = muteWordsService.create as jest.Mock;
const removeMock = muteWordsService.remove as jest.Mock;

const STORED_WORD: SerializedMuteWord = {
  id: 'word-1',
  value: 'dogs',
  targets: ['content', 'tag'],
  actorTarget: 'all',
  createdAt: '2026-01-01T00:00:00.000Z',
};

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** This test's client, torn down in `afterEach` so its timers cannot outlive the run. */
let queryClient: QueryClient | null = null;

async function openScreen(): Promise<TestRenderer.ReactTestRenderer> {
  // `gcTime: 0` on BOTH matters: a settled query or mutation is otherwise held
  // for the default five minutes, and that timer outlives the run and keeps
  // jest's worker open (same reason as `useFeedSettingsInstantSave.test.tsx`).
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false, gcTime: 0 },
    },
  });
  queryClient = client;
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <QueryClientProvider client={client}>
        <HiddenWordsScreen />
      </QueryClientProvider>,
    );
  });
  await flush();
  return renderer;
}

function pressByLabel(renderer: TestRenderer.ReactTestRenderer, label: string): void {
  const target = renderer.root
    .findAllByType(TouchableOpacity)
    .find((node) => node.props.accessibilityLabel === label);
  if (!target) throw new Error(`No pressable labelled "${label}"`);
  act(() => {
    target.props.onPress();
  });
}

describe('the muted-words screen reports every change it lands', () => {
  beforeAll(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockConfirm.mockResolvedValue(true);
    listMock.mockResolvedValue([]);
  });

  afterEach(() => {
    queryClient?.clear();
    queryClient?.unmount();
    queryClient = null;
  });

  it('reports a muted word once the server has stored it', async () => {
    createMock.mockResolvedValue(STORED_WORD);

    const screen = await openScreen();
    act(() => {
      screen.root.findByType(TextInput).props.onChangeText('dogs');
    });
    pressByLabel(screen, 'settings.privacy.addMutedWord');
    await flush();

    expect(createMock).toHaveBeenCalledWith('dogs');
    expect(mockInvalidate).toHaveBeenCalledTimes(1);

    act(() => screen.unmount());
  });

  it('reports an unmuted word once the server has removed it', async () => {
    listMock.mockResolvedValue([STORED_WORD]);
    removeMock.mockResolvedValue(undefined);
    mockConfirm.mockResolvedValue(true);

    const screen = await openScreen();
    pressByLabel(screen, 'settings.privacy.removeMutedWord');
    expect(mockConfirm).toHaveBeenCalledWith(expect.objectContaining({ destructive: true }));
    await flush();

    expect(removeMock).toHaveBeenCalledWith(STORED_WORD.id);
    expect(mockInvalidate).toHaveBeenCalledTimes(1);

    act(() => screen.unmount());
  });

  it('does not mutate when the shared confirmation is cancelled', async () => {
    listMock.mockResolvedValue([STORED_WORD]);
    mockConfirm.mockResolvedValue(false);
    const screen = await openScreen();
    pressByLabel(screen, 'settings.privacy.removeMutedWord');
    await flush();
    expect(removeMock).not.toHaveBeenCalled();
    expect(mockInvalidate).not.toHaveBeenCalled();
    act(() => screen.unmount());
  });

  it('reports nothing when the server refuses the change', async () => {
    createMock.mockRejectedValue(new Error('network'));

    const screen = await openScreen();
    act(() => {
      screen.root.findByType(TextInput).props.onChangeText('dogs');
    });
    pressByLabel(screen, 'settings.privacy.addMutedWord');
    await flush();

    // A refused change leaves every surface exactly as the caches already have
    // it — telling them otherwise would throw away a feed for nothing.
    expect(mockInvalidate).not.toHaveBeenCalled();

    act(() => screen.unmount());
  });
});
