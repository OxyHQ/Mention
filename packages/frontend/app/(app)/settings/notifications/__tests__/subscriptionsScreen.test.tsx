import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { PostSubscriptionListResponse } from '@mention/shared-types';
import enMessages from '@/locales/en.json';

/**
 * Render tests for the activity-subscriptions screen — the three behaviours that
 * only show up once the screen is actually mounted:
 *
 *  1. A viewer with ZERO subscriptions lands on the empty state, not a spinner
 *     that never resolves. (The failure mode is a query whose `isLoading` never
 *     clears, which reads identically to "still loading" forever.)
 *  2. An author Oxy could not resolve renders the degraded summary. The raw
 *     `oxyUserId` must appear NOWHERE in the rendered text — `/@<id>` is not a
 *     profile, and a transient lookup failure must not look like a real account.
 *  3. Subscribing from a PROFILE updates this screen without a reload. That is
 *     asserted across both surfaces sharing ONE QueryClient: the profile bell's
 *     hook invalidates, and the mounted screen refetches. A key mismatch between
 *     the two — the only way they can disagree — fails here.
 *
 * Mocks stop at the module boundary: the SDK packages (`@oxyhq/services`,
 * `@oxyhq/bloom`) that ship untranspiled TS source, and the service that talks
 * HTTP. Everything from the screen down through the real `ProfileCard` and
 * `UserName` is the code under test. `t` resolves against the REAL `en.json`, so
 * a missing i18n key fails here instead of shipping a raw key.
 */

type MessageNode = string | number | boolean | null | MessageNode[] | { [key: string]: MessageNode };
const messages: { [key: string]: MessageNode } = enMessages;

function mockTranslate(key: string, vars?: Record<string, string> & { defaultValue?: string }): string {
  // i18next resolves a dotted key against nested objects AND flat dotted keys.
  const direct = messages[key];
  const nested =
    typeof direct === 'string'
      ? direct
      : key
          .split('.')
          .reduce<MessageNode | undefined>(
            (node, part) =>
              typeof node === 'object' && node !== null && !Array.isArray(node)
                ? node[part]
                : undefined,
            messages,
          );
  const value = typeof nested === 'string' ? nested : vars?.defaultValue;
  if (typeof value !== 'string') return key;
  if (!vars) return value;
  return value.replace(/\{\{(\w+)\}\}/g, (_m, name: string) => String(vars[name] ?? ''));
}

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: mockTranslate }),
}));

jest.mock('expo-router', () => ({
  router: { push: jest.fn() },
  useRouter: () => ({ push: jest.fn() }),
  usePathname: () => '/settings/notifications/subscriptions',
  useLocalSearchParams: () => ({}),
  useFocusEffect: jest.fn(),
  Link: () => null,
}));

jest.mock('@/hooks/useSafeBack', () => ({ useSafeBack: () => jest.fn() }));

const mockAuth = {
  user: { id: 'viewer-1' },
  canUsePrivateApi: true,
  isPrivateApiPending: false,
};

jest.mock('@oxyhq/services/ui/client', () => {
  const { Text, View } = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    useAuth: () => mockAuth,
    OxyAuthPrompt: ({ label }: { label?: string }) => <Text>{label}</Text>,
    FollowButton: () => <View testID="follow-button" />,
  };
});

interface HandleUser {
  username?: string;
  handle?: string;
  isFederated?: boolean;
  type?: string;
  instance?: string;
  federation?: { domain?: string };
}

jest.mock('@oxyhq/core', () => ({
  getNormalizedUserHandle: (user?: HandleUser | null): string | null => {
    const username = (user?.username ?? user?.handle ?? '').trim().replace(/^@/, '');
    if (username.length === 0) return null;
    const isFederated = user?.isFederated === true || user?.type === 'federated';
    const instance = (user?.instance ?? user?.federation?.domain ?? '').trim().replace(/^@/, '');
    if (isFederated && instance.length > 0 && !username.includes('@')) {
      return `${username}@${instance}`;
    }
    return username;
  },
}));

jest.mock('@oxyhq/bloom/avatar', () => {
  const { View } = jest.requireActual<typeof import('react-native')>('react-native');
  return { Avatar: () => <View testID="avatar" /> };
});

jest.mock('@oxyhq/bloom/skeleton', () => {
  const { View } = jest.requireActual<typeof import('react-native')>('react-native');
  const Box = ({ children }: { children?: React.ReactNode }) => (
    <View testID="skeleton">{children}</View>
  );
  return { Row: Box, Col: Box, Text: Box, Circle: Box, Pill: Box, Box };
});

jest.mock('@oxyhq/bloom/theme', () => ({
  useTheme: () => ({
    colors: {
      primary: '#0000ff',
      text: '#000000',
      textSecondary: '#666666',
      border: '#cccccc',
      error: '#ff0000',
      card: '#ffffff',
    },
  }),
}));

jest.mock('@oxyhq/bloom/loading', () => {
  const { View } = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    SpinnerIcon: () => <View testID="spinner" />,
    Loading: () => <View testID="spinner" />,
  };
});

jest.mock('@oxyhq/bloom/toast', () => ({ toast: jest.fn() }));

// Reached through `IconButton` (components/ui/Button).
jest.mock('@oxyhq/bloom/hooks', () => ({
  useHaptics: () => ({ trigger: jest.fn(), impact: jest.fn(), selection: jest.fn() }),
  useInteractionState: () => ({ pressed: false, hovered: false }),
  useInteractionStates: () => ({ pressed: false, hovered: false }),
}));

jest.mock('@oxyhq/bloom/button', () => {
  const { Text, TouchableOpacity } =
    jest.requireActual<typeof import('react-native')>('react-native');
  const Button = ({ label, onPress }: { label?: string; onPress?: () => void }) => (
    <TouchableOpacity accessibilityRole="button" accessibilityLabel={label} onPress={onPress}>
      <Text>{label}</Text>
    </TouchableOpacity>
  );
  return { Button, ButtonText: Text };
});

jest.mock('@oxyhq/bloom/settings-list', () => {
  const { Text, View } = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    SettingsListGroup: ({ children }: { children?: React.ReactNode }) => <View>{children}</View>,
    SettingsListItem: ({ title, description }: { title?: string; description?: string }) => (
      <View>
        <Text>{title}</Text>
        <Text>{description}</Text>
      </View>
    ),
  };
});

const mockList = jest.fn<Promise<PostSubscriptionListResponse>, [string?, number?]>();
const mockUnsubscribe = jest.fn();
const mockSubscribe = jest.fn();
const mockGetStatus = jest.fn();

jest.mock('@/services/subscriptionService', () => ({
  subscriptionService: {
    list: (...args: [string?, number?]) => mockList(...args),
    unsubscribe: (...args: unknown[]) => mockUnsubscribe(...args),
    subscribe: (...args: unknown[]) => mockSubscribe(...args),
    getStatus: (...args: unknown[]) => mockGetStatus(...args),
  },
}));

import ActivitySubscriptionsScreen from '../subscriptions';
import { useSubscription } from '@/components/Profile/hooks/useSubscription';

// ── Helpers ─────────────────────────────────────────────────────────────────

type JsonNode = TestRenderer.ReactTestRendererJSON | string | null;

/** Every string rendered anywhere in the tree, flattened. */
function collectText(node: JsonNode | JsonNode[]): string[] {
  if (node === null || node === undefined) return [];
  if (typeof node === 'string') return [node];
  if (Array.isArray(node)) return node.flatMap(collectText);
  return (node.children ?? []).flatMap((child) => collectText(child as JsonNode));
}

function renderedText(renderer: TestRenderer.ReactTestRenderer): string {
  return collectText(renderer.toJSON() as JsonNode | JsonNode[]).join(' | ');
}

/**
 * The same text with no separators, for assertions on strings the UI splits
 * across nodes — `UserName` renders the sigil and the handle as two `Text`
 * children, so `@ada` never appears in a single node.
 */
function compactText(renderer: TestRenderer.ReactTestRenderer): string {
  return collectText(renderer.toJSON() as JsonNode | JsonNode[]).join('');
}

/**
 * Drive the tree until React Query has no fetch in flight.
 *
 * A single `act` flushes one microtask turn, which is NOT enough for
 * mount → effect → fetch → resolve → re-render; reading the tree before that
 * lands shows the skeleton branch and makes every content assertion fail for a
 * reason that has nothing to do with the component. Settling on the client's own
 * `isFetching` (rather than on the absence of a skeleton) keeps the "no spinner
 * left behind" assertions honest: if a query genuinely never resolves, this
 * throws instead of quietly reporting a passing empty state.
 */
/** One turn of the macrotask queue inside `act` — for state that must land while a request is still in flight. */
async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
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

function author(id: string, username: string, displayName: string) {
  return { id, username, name: { displayName }, avatar: `file-${id}`, verified: false };
}

/** The exact degraded shape the backend emits for an unresolvable author. */
function degradedAuthor(id: string) {
  return { id, username: '', name: { displayName: 'Unknown user' }, avatar: null };
}

/**
 * Every client and renderer this file creates, torn down in `afterEach`. A
 * QueryClient left behind keeps its garbage-collection timers armed past the end
 * of the run and holds jest's worker open.
 */
const clients: QueryClient[] = [];
const renderers: TestRenderer.ReactTestRenderer[] = [];

function makeClient(): QueryClient {
  const client = new QueryClient({
    // `mutations.gcTime` matters as much as the query one: a SETTLED mutation is
    // otherwise held for the default five minutes, and that timer outlives the
    // run and keeps jest's worker open.
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false, gcTime: 0 },
    },
  });
  clients.push(client);
  return client;
}

async function renderScreen(client: QueryClient) {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <QueryClientProvider client={client}>
        <ActivitySubscriptionsScreen />
      </QueryClientProvider>,
    );
  });
  await settle(client);
  renderers.push(renderer);
  return renderer;
}

describe('activity subscriptions screen', () => {
  beforeEach(() => {
    mockList.mockReset();
    mockUnsubscribe.mockReset().mockResolvedValue({ subscribed: false });
    mockSubscribe.mockReset().mockResolvedValue({ subscribed: true });
    mockGetStatus.mockReset().mockResolvedValue({ subscribed: false });
  });

  afterEach(() => {
    act(() => {
      renderers.forEach((renderer) => renderer.unmount());
    });
    renderers.length = 0;
    clients.forEach((client) => {
      client.getMutationCache().clear();
      client.clear();
      client.unmount();
    });
    clients.length = 0;
  });

  it('shows the empty state, not a spinner, when the viewer has no subscriptions', async () => {
    mockList.mockResolvedValue({ subscriptions: [] });

    const renderer = await renderScreen(makeClient());
    const text = renderedText(renderer);

    expect(mockList).toHaveBeenCalled();
    expect(text).toContain('No activity notifications');
    expect(text).toContain('tap the bell');
    // The load has SETTLED: no skeleton rows and no spinner left behind.
    expect(renderer.root.findAllByProps({ testID: 'skeleton' })).toHaveLength(0);
    expect(renderer.root.findAllByProps({ testID: 'spinner' })).toHaveLength(0);
  });

  it('renders a subscribed account as a row', async () => {
    mockList.mockResolvedValue({
      subscriptions: [{ author: author('a-1', 'ada', 'Ada Lovelace'), createdAt: '2026-07-02T00:00:00.000Z' }],
    });

    const renderer = await renderScreen(makeClient());
    const text = renderedText(renderer);

    expect(text).toContain('Ada Lovelace');
    expect(compactText(renderer)).toContain('@ada');
    expect(text).not.toContain('No activity notifications');
  });

  it('renders an unresolvable author as the degraded summary, never as a raw id', async () => {
    const GHOST_ID = '68f0c9178fcdefaf81988fff';
    mockList.mockResolvedValue({
      subscriptions: [{ author: degradedAuthor(GHOST_ID), createdAt: '2026-07-02T00:00:00.000Z' }],
    });

    const renderer = await renderScreen(makeClient());
    const text = renderedText(renderer);

    expect(text).toContain('Unknown user');
    // The ghost-handle rule: the raw id is never rendered, as a handle or otherwise.
    expect(compactText(renderer)).not.toContain(GHOST_ID);
  });

  it('removes a row optimistically when its bell is pressed', async () => {
    mockList.mockResolvedValue({
      subscriptions: [
        { author: author('a-1', 'ada', 'Ada Lovelace'), createdAt: '2026-07-02T00:00:00.000Z' },
        { author: author('a-2', 'grace', 'Grace Hopper'), createdAt: '2026-07-01T00:00:00.000Z' },
      ],
    });

    const client = makeClient();
    const renderer = await renderScreen(client);
    expect(renderedText(renderer)).toContain('Ada Lovelace');

    const bell = renderer.root.findByProps({
      accessibilityLabel: 'Turn off notifications for @ada',
    });

    // Hold the unsubscribe in flight: the row must be gone BEFORE the server
    // answers, which is what makes the removal optimistic rather than a refetch.
    let release!: () => void;
    mockUnsubscribe.mockReturnValue(
      new Promise((resolve) => {
        release = () => resolve({ subscribed: false });
      }),
    );

    await act(async () => {
      bell.props.onPress();
    });
    // `onMutate` awaits `cancelQueries` before writing, so the optimistic update
    // lands a turn later — but still while the request is unanswered.
    await flush();

    expect(mockUnsubscribe).toHaveBeenCalledWith('a-1');
    // Non-vacuous: the row is gone WHILE the server is still thinking.
    expect(client.isMutating()).toBe(1);
    const afterPress = renderedText(renderer);
    expect(afterPress).not.toContain('Ada Lovelace');
    expect(afterPress).toContain('Grace Hopper');

    await act(async () => {
      release();
    });
    await settle(client);
  });

  it('reflects a subscribe made from a profile, with no reload', async () => {
    // The screen starts empty…
    mockList.mockResolvedValue({ subscriptions: [] });
    const client = makeClient();
    const renderer = await renderScreen(client);
    expect(renderedText(renderer)).toContain('No activity notifications');
    expect(mockList).toHaveBeenCalledTimes(1);

    // …then the PROFILE bell subscribes. Same QueryClient, different surface.
    mockList.mockResolvedValue({
      subscriptions: [{ author: author('a-9', 'ada', 'Ada Lovelace'), createdAt: '2026-07-03T00:00:00.000Z' }],
    });

    let toggle!: () => Promise<void>;
    function ProfileBellProbe() {
      ({ toggle } = useSubscription('a-9', 'viewer-1', false));
      return null;
    }

    // Captured for teardown: `useDeferredToggle` arms a 500ms status-fetch timer
    // on mount, which outlives the run if the probe is never unmounted.
    await act(async () => {
      renderers.push(
        TestRenderer.create(
          <QueryClientProvider client={client}>
            <ProfileBellProbe />
          </QueryClientProvider>,
        ),
      );
    });

    await act(async () => {
      await toggle();
    });
    await settle(client);

    expect(mockSubscribe).toHaveBeenCalledWith('a-9');
    // The already-mounted screen refetched and now shows the new account — no
    // remount, no navigation, no manual refresh.
    expect(mockList).toHaveBeenCalledTimes(2);
    expect(renderedText(renderer)).toContain('Ada Lovelace');
  });
});
