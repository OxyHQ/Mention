import React from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import TestRenderer, { act } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ChannelWritersResponse } from '@mention/shared-types';
import enMessages from '@/locales/en.json';

/**
 * A CHANNEL'S WRITERS TAB — the rule, and the two facts it must tell apart.
 *
 * The tab exists when the channel NAMES the people who write for it. Nothing on
 * the profile DTO says so: the disclosure is a Mention-owned setting on the
 * channel account, and `GET /channels/:id/writers` reports it only by REFUSING —
 * one 404 for "not a channel", for "does not sign its posts", and for "you may
 * not see this channel". So the tab is keyed on the query having SUCCEEDED.
 *
 * That makes one distinction load-bearing, and it is the reason this file exists
 * rather than a single happy-path fixture:
 *
 *  - **404** ⇒ there is no list ⇒ NO TAB.
 *  - **200 with `writers: []`** ⇒ the list exists and is empty ⇒ the tab is
 *    there, saying so.
 *
 * A suite whose endpoint always answers 200 cannot tell "tab when disclosing"
 * from "tab always", and a suite that reads `writers.length` instead of the
 * query's success cannot tell an empty masthead from an undisclosed one. Both
 * fixtures are therefore present below, and they are asserted to produce
 * DIFFERENT outcomes rather than each merely producing its own.
 *
 * Mocks stop at the module boundary: the SDK packages that ship untranspiled TS,
 * and the HTTP client. `channelWritersService`, `useChannelWriters`,
 * `buildProfileTabDescriptors`, `ProfileWriters` and the real `ProfileCard`
 * beneath it are all the code under test — which is what lets the ghost-handle
 * assertion mean anything. `t` resolves against the REAL `en.json`, so a missing
 * catalog entry fails here instead of shipping a raw key.
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
  Link: () => null,
}));

const mockAuth = {
  user: { id: 'viewer-1' } as { id: string } | null,
  canUsePrivateApi: true,
  isPrivateApiPending: false,
};

jest.mock('@oxyhq/services/ui/client', () => {
  const { View } = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    useAuth: () => mockAuth,
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

// Reached through ProfileCard → UserName (its copyable handle).
jest.mock('@oxyhq/bloom/toast', () => ({ toast: jest.fn() }));

// Reached through `SecondaryButton` (components/ui/Button).
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

// Reached through ProfileCard → RemoteActorBadge → FediverseInfoDialog.
jest.mock('@oxyhq/bloom/dialog', () => {
  const { View } = jest.requireActual<typeof import('react-native')>('react-native');
  const Passthrough = ({ children }: { children?: React.ReactNode }) => <View>{children}</View>;
  return {
    Dialog: Passthrough,
    DialogContent: Passthrough,
    DialogHeader: Passthrough,
    DialogTitle: Passthrough,
    DialogDescription: Passthrough,
    DialogFooter: Passthrough,
    DialogTrigger: Passthrough,
    BottomSheet: Passthrough,
    useDialogControl: () => ({ open: jest.fn(), close: jest.fn() }),
  };
});

/**
 * The HTTP boundary, not the service — so the request path, the cursor
 * round-trip and the service's refusal to swallow a 404 are all under test. A
 * mock of `channelWritersService` would assert only that the hook calls it.
 */
const mockGet = jest.fn();
jest.mock('@/utils/api', () => ({
  authenticatedClient: {
    get: (...args: unknown[]) => mockGet(...args),
  },
}));

import { useChannelWriters } from '../hooks/useChannelWriters';
import { ProfileWriters } from '../ProfileWriters';
import { buildProfileTabDescriptors, CHANNEL_ONLY_TAB_NAMES, TAB_NAMES, type ProfileTab } from '../types';
import { viewerQueryKeys } from '@/lib/viewerQueryKeys';

// ── Fixtures ────────────────────────────────────────────────────────────────

const CHANNEL_ID = 'channel-oxy-1';

function writer(id: string, username: string, displayName: string) {
  return { id, username, name: { displayName }, avatar: `file-${id}`, verified: false };
}

/** The exact degraded shape the backend emits for a writer Oxy could not resolve. */
function degradedWriter(id: string) {
  return { id, username: '', name: { displayName: 'Unknown user' }, avatar: null };
}

/** What the endpoint answers for every refusal — the same body for all of them. */
function notFound(): Error & { response: { status: number } } {
  return Object.assign(new Error('Request failed with status code 404'), {
    response: { status: 404, data: { message: 'No writers list for that account' } },
  });
}

/** The linked client peels the backend's `{ data }` envelope before this layer. */
function page(body: ChannelWritersResponse): { data: ChannelWritersResponse } {
  return { data: body };
}

const LABELS: Record<ProfileTab, string> = Object.fromEntries(
  [...TAB_NAMES, ...CHANNEL_ONLY_TAB_NAMES].map((tab) => [tab, `label:${tab}`]),
) as Record<ProfileTab, string>;

// ── Harness ─────────────────────────────────────────────────────────────────

type Hook = ReturnType<typeof useChannelWriters>;
let latest: Hook | null = null;

function Probe({ channelId }: { channelId: string | undefined }) {
  latest = useChannelWriters(channelId);
  return null;
}

const clients: QueryClient[] = [];
const renderers: TestRenderer.ReactTestRenderer[] = [];

/**
 * `retry: 1` on the CLIENT, not `false`.
 *
 * The hook sets `retry: false` for itself, and a client that also refuses to
 * retry would make that option unobservable — the "asks once" case below would
 * pass with the hook's option deleted. A client that WOULD retry is what turns
 * that assertion into a real one. `retryDelay: 0` keeps it instant, and
 * `gcTime: 0` stops a settled query holding a five-minute timer past the run.
 */
function newClient(): QueryClient {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: 1, retryDelay: 0, gcTime: 0 },
      mutations: { retry: false, gcTime: 0 },
    },
  });
  clients.push(client);
  return client;
}

function render(element: React.ReactElement, client: QueryClient): TestRenderer.ReactTestRenderer {
  let renderer: TestRenderer.ReactTestRenderer | null = null;
  act(() => {
    renderer = TestRenderer.create(
      <QueryClientProvider client={client}>{element}</QueryClientProvider>,
    );
  });
  const created = renderer as unknown as TestRenderer.ReactTestRenderer;
  renderers.push(created);
  return created;
}

/**
 * Advance the world until `predicate` holds.
 *
 * CONDITION-based, and on a value the tree has actually RENDERED — never on
 * `client.isFetching()`. React Query notifies its subscribers on a macrotask
 * AFTER the fetch count drops, so a wait that stops at `isFetching() === 0`
 * reads the probe before it has re-rendered and sees the pre-settle value. That
 * is a race, and it is one that only loses under load: every case in this file
 * passed run on its own and one of them took the full suite red.
 *
 * The iteration cap is a FAILURE ceiling, not the wait — a condition that never
 * becomes true reports itself by name instead of hanging to jest's timeout.
 */
async function waitUntil(predicate: () => boolean, description: string): Promise<void> {
  const FAILURE_CEILING = 500;
  for (let attempt = 0; attempt < FAILURE_CEILING; attempt += 1) {
    if (predicate()) return;
    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
  throw new Error(`waitUntil never saw: ${description}`);
}

/**
 * The hook has settled EITHER WAY — `loading` is the query's own `isPending`,
 * which clears on success and on refusal alike. Waiting on it rather than on the
 * expected outcome is what keeps the empty and refused cases from becoming
 * tautologies.
 */
async function settleHook(): Promise<void> {
  await waitUntil(() => latest !== null && !latest.loading, 'the writers query to settle');
}

/** Whether the list is still showing its loading placeholder rows. */
function showsSkeleton(renderer: TestRenderer.ReactTestRenderer): boolean {
  return renderer.root.findAllByProps({ testID: 'skeleton' }).length > 0;
}

/** The rendered list has stopped loading — a signal independent of what it then shows. */
async function settleUi(renderer: TestRenderer.ReactTestRenderer): Promise<void> {
  await waitUntil(() => !showsSkeleton(renderer), 'the writers list to stop loading');
}

/** Nothing should be in flight — for the case where no request is made at all. */
async function settleIdle(client: QueryClient): Promise<void> {
  await waitUntil(() => client.isFetching() === 0, 'React Query to go idle');
}

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

/** The same text with no separators — `UserName` splits `@ada` across nodes. */
function compactText(renderer: TestRenderer.ReactTestRenderer): string {
  return collectText(renderer.toJSON() as JsonNode | JsonNode[]).join('');
}

/** The tab strip a channel gets for a given disclosure answer. */
function channelStrip(disclosed: boolean): string[] {
  return buildProfileTabDescriptors(LABELS, [], 'channel', disclosed).map((d) => d.key);
}

beforeEach(() => {
  mockGet.mockReset();
  mockAuth.user = { id: 'viewer-1' };
  latest = null;
});

afterEach(() => {
  for (const renderer of renderers.splice(0)) {
    act(() => renderer.unmount());
  }
  for (const client of clients.splice(0)) {
    client.clear();
    client.unmount();
  }
});

// ── The refusal, and what it means for the tab ──────────────────────────────

describe('a channel that does not name its writers has no tab', () => {
  it('reports NOT disclosed when the endpoint refuses', async () => {
    mockGet.mockRejectedValue(notFound());
    const client = newClient();
    render(<Probe channelId={CHANNEL_ID} />, client);
    await settleHook();

    expect(latest?.disclosed).toBe(false);
    expect(latest?.writers).toEqual([]);
  });

  it('asks exactly once — the refusal is an answer, not an error to retry', async () => {
    mockGet.mockRejectedValue(notFound());
    const client = newClient();
    render(<Probe channelId={CHANNEL_ID} />, client);
    await settleHook();

    // The client above WOULD retry; only the hook's own `retry: false` stops it.
    expect(mockGet).toHaveBeenCalledTimes(1);
  });

  it('does not ask at all before the channel has resolved', async () => {
    const client = newClient();
    render(<Probe channelId={undefined} />, client);
    await settleIdle(client);

    expect(mockGet).not.toHaveBeenCalled();
    // Unresolved is not disclosed: no tab until something affirmatively says so.
    expect(latest?.disclosed).toBe(false);
  });
});

describe('a disclosing channel with nothing published keeps its tab', () => {
  it('reports DISCLOSED for a 200 whose list is empty', async () => {
    mockGet.mockResolvedValue(page({ writers: [] }));
    const client = newClient();
    render(<Probe channelId={CHANNEL_ID} />, client);
    await settleHook();

    expect(latest?.disclosed).toBe(true);
    expect(latest?.writers).toEqual([]);
  });

  /**
   * THE discriminator. Both fixtures produce an empty list, so any rule that
   * reads `writers.length` answers them identically — and would hide the tab of
   * a channel that has genuinely opted in. Only the query's success tells them
   * apart, and the two strips must therefore differ.
   */
  it('gives the empty-200 channel a writers tab and the 404 channel none', async () => {
    mockGet.mockResolvedValue(page({ writers: [] }));
    const disclosingClient = newClient();
    render(<Probe channelId={CHANNEL_ID} />, disclosingClient);
    await settleHook();
    const disclosedAnswer = latest?.disclosed ?? false;
    const emptyWriters = latest?.writers ?? [];

    mockGet.mockReset();
    mockGet.mockRejectedValue(notFound());
    const refusingClient = newClient();
    render(<Probe channelId={CHANNEL_ID} />, refusingClient);
    await settleHook();
    const refusedAnswer = latest?.disclosed ?? false;

    // Same rendered list on both sides…
    expect(emptyWriters).toEqual([]);
    expect(latest?.writers).toEqual([]);
    // …opposite answers to the only question the tab asks…
    expect(disclosedAnswer).toBe(true);
    expect(refusedAnswer).toBe(false);
    // …and therefore two different tab strips.
    expect(channelStrip(disclosedAnswer)).toContain('writers');
    expect(channelStrip(refusedAnswer)).not.toContain('writers');
    expect(channelStrip(disclosedAnswer)).not.toEqual(channelStrip(refusedAnswer));
  });
});

// ── The list itself ─────────────────────────────────────────────────────────

describe('the writers list', () => {
  it('requests the channel’s own writers path', async () => {
    mockGet.mockResolvedValue(page({ writers: [] }));
    const client = newClient();
    render(<Probe channelId={CHANNEL_ID} />, client);
    await settleHook();

    // Asserted by path: a typo here type-checks and ships as a channel that
    // never discloses, which is indistinguishable from one that opted out.
    expect(mockGet).toHaveBeenCalledWith(`/channels/${CHANNEL_ID}/writers`, { params: {} });
  });

  it('follows nextCursor and appends the next page', async () => {
    mockGet
      .mockResolvedValueOnce(
        page({
          writers: [{ writer: writer('w1', 'ada', 'Ada'), lastPostAt: '2026-08-01T00:00:00.000Z' }],
          nextCursor: 'cursor-1',
        }),
      )
      .mockResolvedValueOnce(
        page({
          writers: [{ writer: writer('w2', 'bea', 'Bea'), lastPostAt: '2026-07-01T00:00:00.000Z' }],
        }),
      );

    const client = newClient();
    render(<Probe channelId={CHANNEL_ID} />, client);
    await settleHook();

    expect(latest?.hasMore).toBe(true);
    expect(latest?.writers.map((entry) => entry.writer.id)).toEqual(['w1']);

    act(() => latest?.loadMore());
    await waitUntil(() => (latest?.writers.length ?? 0) === 2, 'the second page to land');

    expect(mockGet).toHaveBeenLastCalledWith(`/channels/${CHANNEL_ID}/writers`, {
      params: { cursor: 'cursor-1' },
    });
    expect(latest?.writers.map((entry) => entry.writer.id)).toEqual(['w1', 'w2']);
    // No `nextCursor` on the second page is the end of the list.
    expect(latest?.hasMore).toBe(false);
  });

  it('caches under the VIEWER’s key, so one reader’s refusal is not another’s', async () => {
    mockGet.mockResolvedValue(page({ writers: [] }));
    const client = newClient();
    render(<Probe channelId={CHANNEL_ID} />, client);
    await settleHook();

    expect(client.getQueryData(viewerQueryKeys.channelWriters('viewer-1', CHANNEL_ID))).toBeDefined();
    expect(client.getQueryData(viewerQueryKeys.channelWriters('viewer-2', CHANNEL_ID))).toBeUndefined();
  });
});

// ── What the tab renders ────────────────────────────────────────────────────

describe('the writers tab on screen', () => {
  it('says the list is empty rather than showing nothing', async () => {
    mockGet.mockResolvedValue(page({ writers: [] }));
    const client = newClient();
    const renderer = render(<ProfileWriters channelOxyUserId={CHANNEL_ID} />, client);
    await settleUi(renderer);

    expect(renderedText(renderer)).toContain('No writers yet');
    expect(renderedText(renderer)).toContain('This channel names the person who wrote each post');
  });

  it('names each writer, when they last wrote, and what the list is', async () => {
    mockGet.mockResolvedValue(
      page({
        writers: [
          { writer: writer('w1', 'ada', 'Ada Lovelace'), lastPostAt: new Date().toISOString() },
        ],
      }),
    );
    const client = newClient();
    const renderer = render(<ProfileWriters channelOxyUserId={CHANNEL_ID} />, client);
    await settleUi(renderer);

    const text = renderedText(renderer);
    expect(text).toContain('Ada Lovelace');
    expect(text).toContain('Last wrote');
    // The caption is what stops a reader taking a masthead for a member roll.
    expect(text).toContain('The people this channel has named on its posts.');
  });

  /**
   * The ghost-handle rule, on this surface. A writer Oxy could not resolve must
   * render as "Unknown user" with no `@handle` line and no `/@<id>` link — the
   * raw id is not a profile, and a transient lookup failure must not look like a
   * real account. It holds because the row IS `ProfileCard`; this asserts the
   * DTO reaches it untouched, so a future hand-built row here fails.
   */
  it('never renders an unresolvable writer’s raw id', async () => {
    const ghostId = 'ghost-oxy-id-000';
    mockGet.mockResolvedValue(
      page({
        writers: [{ writer: degradedWriter(ghostId), lastPostAt: new Date().toISOString() }],
      }),
    );
    const client = newClient();
    const renderer = render(<ProfileWriters channelOxyUserId={CHANNEL_ID} />, client);
    await settleUi(renderer);

    expect(compactText(renderer)).toContain('Unknown user');
    expect(compactText(renderer)).not.toContain(ghostId);
    expect(compactText(renderer)).not.toContain(`@${ghostId}`);
  });

  it('offers a load-more control only while there is another page', async () => {
    mockGet.mockResolvedValue(
      page({
        writers: [{ writer: writer('w1', 'ada', 'Ada'), lastPostAt: new Date().toISOString() }],
        nextCursor: 'cursor-1',
      }),
    );
    const client = newClient();
    const renderer = render(<ProfileWriters channelOxyUserId={CHANNEL_ID} />, client);
    await settleUi(renderer);
    expect(renderedText(renderer)).toContain('Load more');

    mockGet.mockReset();
    mockGet.mockResolvedValue(
      page({
        writers: [{ writer: writer('w1', 'ada', 'Ada'), lastPostAt: new Date().toISOString() }],
      }),
    );
    const lastPageClient = newClient();
    const lastPageRenderer = render(<ProfileWriters channelOxyUserId={CHANNEL_ID} />, lastPageClient);
    await settleUi(lastPageRenderer);
    expect(renderedText(lastPageRenderer)).not.toContain('Load more');
  });
});

// ── The wiring the screen owns ──────────────────────────────────────────────

/**
 * `ChannelProfile` is not exported and mounting the whole profile shell to reach
 * it would test the shell, so the ONE line this file cannot otherwise reach is
 * pinned by reading the source: the strip's writers flag must come from the
 * hook's answer. A literal `true` there — the obvious "simplify" — gives every
 * channel a writers tab, including ones that opted out, and every other
 * assertion in this file still passes.
 */
describe('the channel screen feeds the endpoint’s answer into its tab strip', () => {
  const CHANNEL_SCREEN = join(__dirname, '..', '..', 'ChannelScreen.tsx');
  const source = readFileSync(CHANNEL_SCREEN, 'utf8');

  it('read a plausible file, so the assertions below are not vacuous', () => {
    expect(source.length).toBeGreaterThan(2000);
    expect(source).toContain('buildProfileTabDescriptors');
  });

  it('takes the flag from useChannelWriters and passes it as the strip’s fourth argument', () => {
    expect(source).toMatch(/const \{ disclosed: disclosesWriters \} = useChannelWriters\(/);
    expect(source).toMatch(/'channel',\s*disclosesWriters,/);
  });
});
