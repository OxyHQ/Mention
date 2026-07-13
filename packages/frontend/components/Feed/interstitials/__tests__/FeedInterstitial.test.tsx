import React from 'react';
import { ScrollView, TouchableOpacity } from 'react-native';
import TestRenderer, { act, type ReactTestInstance } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { FeedInterstitialKind, FeedInterstitialSlot } from '@mention/shared-types';
import type { ProfileData } from '@/lib/recommendations';
import type { MarketplaceFeed } from '@/services/customFeedsService';
import type { StarterPackSummary } from '@/services/starterPacksService';
import enMessages from '@/locales/en.json';

import FeedInterstitial from '../FeedInterstitial';
import { SuggestedFeedsInterstitial } from '../SuggestedFeedsInterstitial';
import { SuggestedStarterPacksInterstitial } from '../SuggestedStarterPacksInterstitial';
import { SuggestedUsersInterstitial } from '../SuggestedUsersInterstitial';

/**
 * Render tests for the three feed recommendation bands.
 *
 * The contract every band shares — and the one the pure-layout tests
 * (`interstitialLayout.test.ts`) can only prove half of — is that a band with
 * too little to say renders NOTHING: not an empty band, not a lone header, not
 * a stray border. These tests drive the real components through the real
 * `InterstitialShell` and assert on the rendered tree.
 *
 * Mocks stop at the module boundary the band talks to: the data hooks/services
 * that fetch suggestions, the responsive hook that decides the layout, and the
 * SDK packages (`@oxyhq/services`, `@oxyhq/bloom`) that ship untranspiled TS
 * source. Everything from the interstitial down to the `ProfileCard` /
 * `FeedCard` / `StarterPackCard` rows — including the dismiss buttons and the
 * carousel — is the real component under test.
 */

// ── Module boundaries ───────────────────────────────────────────────────────

type MessageNode = string | number | boolean | null | MessageNode[] | { [key: string]: MessageNode };

const messages: { [key: string]: MessageNode } = enMessages;

/**
 * `t` resolves against the REAL `en.json`, so the tests assert the copy a user
 * actually sees ("Who to follow") and a band wired to a missing i18n key fails
 * here instead of shipping a raw key to production.
 */
function mockTranslate(key: string, vars?: Record<string, string>): string {
  const value = key
    .split('.')
    .reduce<MessageNode | undefined>(
      (node, part) =>
        typeof node === 'object' && node !== null && !Array.isArray(node) ? node[part] : undefined,
      messages,
    );
  if (typeof value !== 'string') return key;
  if (!vars) return value;
  return value.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => vars[name] ?? '');
}

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: mockTranslate }),
}));

jest.mock('expo-router', () => ({
  router: { push: jest.fn() },
  useRouter: () => ({ push: jest.fn() }),
}));

/** The band asks for the viewer + private-API readiness; nothing else. */
const mockAuth = {
  user: { id: 'viewer-1' },
  canUsePrivateApi: true,
  isPrivateApiPending: false,
};

interface FollowButtonProps {
  /** Multi-user mode (starter packs): "follow all these accounts". */
  userIds?: string[];
  /** Single-user mode (the profile row). */
  userId?: string;
  followAllLabel?: string;
  onBulkFollow?: () => void;
}

jest.mock('@oxyhq/services', () => {
  const { Text, TouchableOpacity, View } =
    jest.requireActual<typeof import('react-native')>('react-native');
  return {
    useAuth: () => mockAuth,
    // Faithful to the two modes the real button has, including the one behavior
    // the starter-pack band depends on: in multi-user mode with nobody left to
    // follow it renders NOTHING, so a pack the viewer already followed through
    // shows no dead call-to-action.
    FollowButton: ({ userIds, followAllLabel, onBulkFollow }: FollowButtonProps) => {
      if (userIds === undefined) return <View testID="follow-button" />;
      if (userIds.length === 0) return null;
      return (
        <TouchableOpacity
          accessibilityRole="button"
          accessibilityLabel={followAllLabel}
          onPress={onBulkFollow}>
          <Text>{followAllLabel}</Text>
        </TouchableOpacity>
      );
    },
  };
});

/**
 * `@oxyhq/core` resolves to its ESM build under jest. Only one runtime export
 * reaches these components — the app-wide handle rule — so it is ported here
 * verbatim (username, qualified with the instance for a federated actor, null
 * when there is no username: the ghost-handle rule).
 */
interface HandleUser {
  username?: string | null;
  handle?: string | null;
  isFederated?: boolean;
  type?: string;
  instance?: string | null;
  federation?: { domain?: string | null };
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

jest.mock('@oxyhq/bloom/avatar-group', () => {
  const { View } = jest.requireActual<typeof import('react-native')>('react-native');
  return { AvatarGroup: () => <View testID="avatar-group" /> };
});

jest.mock('@oxyhq/bloom/skeleton', () => {
  const { View } = jest.requireActual<typeof import('react-native')>('react-native');
  const Box = ({ children }: { children?: React.ReactNode }) => (
    <View testID="skeleton">{children}</View>
  );
  return { Row: Box, Col: Box, Text: Box, Circle: Box, Pill: Box, Box };
});

jest.mock('@oxyhq/bloom/pressable-scale', () => {
  const { TouchableOpacity } =
    jest.requireActual<typeof import('react-native')>('react-native');
  return { PressableScale: TouchableOpacity };
});

jest.mock('@oxyhq/bloom/theme', () => ({
  useTheme: () => ({ colors: { primary: '#0000ff' } }),
}));

jest.mock('@oxyhq/bloom/loading', () => {
  const { View } = jest.requireActual<typeof import('react-native')>('react-native');
  return { SpinnerIcon: () => <View testID="spinner" /> };
});

jest.mock('@oxyhq/bloom/toast', () => ({ show: jest.fn() }));

// Reached through ProfileCard → RemoteActorBadge → FediverseInfoDialog.
jest.mock('@oxyhq/bloom/dialog', () => {
  const { View } = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    Dialog: ({ children }: { children?: React.ReactNode }) => <View>{children}</View>,
    useDialogControl: () => ({ open: jest.fn(), close: jest.fn() }),
  };
});

jest.mock('@oxyhq/bloom/button', () => {
  const { TouchableOpacity } =
    jest.requireActual<typeof import('react-native')>('react-native');
  return { Button: TouchableOpacity };
});

/** The breakpoint the band renders for. Flipped per test. */
let mockIsDesktop = true;
jest.mock('@/hooks/useOptimizedMediaQuery', () => ({
  useIsScreenNotMobile: () => mockIsDesktop,
}));

/** The users band reads the shared single-page recommendations cache. */
let mockRecommendations: ProfileData[] = [];
let mockRecommendationsLoading = false;
jest.mock('@/hooks/useRecommendations', () => ({
  useRecommendations: () => ({
    recommendations: mockRecommendations,
    isLoading: mockRecommendationsLoading,
    isFetching: false,
    isError: false,
    error: null,
    refetch: jest.fn(),
  }),
}));

const mockGetMarketplace = jest.fn();
const mockLikeFeed = jest.fn();
jest.mock('@/services/customFeedsService', () => ({
  customFeedsService: {
    getMarketplace: (...args: unknown[]) => mockGetMarketplace(...args),
    likeFeed: (...args: unknown[]) => mockLikeFeed(...args),
  },
}));

const mockListStarterPacks = jest.fn();
const mockUseStarterPack = jest.fn();
jest.mock('@/services/starterPacksService', () => ({
  starterPacksService: {
    list: (...args: unknown[]) => mockListStarterPacks(...args),
    use: (...args: unknown[]) => mockUseStarterPack(...args),
  },
}));

// ── Fixtures ────────────────────────────────────────────────────────────────

/** `count` suggested accounts: Person 1, Person 2, … (`u1`, `u2`, …). */
function users(count: number): ProfileData[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `u${index + 1}`,
    username: `person${index + 1}`,
    name: { displayName: `Person ${index + 1}` },
  }));
}

/** `count` marketplace feeds: Feed 1, Feed 2, … (`f1`, `f2`, …). */
function feeds(count: number): MarketplaceFeed[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `f${index + 1}`,
    ownerOxyUserId: 'owner-1',
    title: `Feed ${index + 1}`,
    description: `About feed ${index + 1}`,
    isPublic: true,
    memberOxyUserIds: [],
    memberCount: 10,
    topicCount: 2,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }));
}

/** `count` starter packs: Pack 1, Pack 2, … (`p1`, `p2`, …). */
function packs(count: number): StarterPackSummary[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `p${index + 1}`,
    name: `Pack ${index + 1}`,
    description: `About pack ${index + 1}`,
    memberOxyUserIds: ['m1', 'm2'],
    memberCount: 2,
    useCount: 5,
    memberAvatars: [],
  }));
}

// ── Rendering ───────────────────────────────────────────────────────────────

const renderers: TestRenderer.ReactTestRenderer[] = [];
const clients: QueryClient[] = [];

/**
 * Let React Query settle: it starts a query/mutation a tick after the render or
 * the press that triggers it, so an assertion made straight afterwards would
 * only ever see the state the band opened in.
 */
async function flush(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
  });
}

/** Render a band and let the fetch it kicks off settle. */
async function renderBand(element: React.ReactElement): Promise<TestRenderer.ReactTestRenderer> {
  // `gcTime: 0` on BOTH caches: a mutation's default 5-minute garbage-collection
  // timer would outlive the test and keep jest's event loop open.
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false, gcTime: 0 },
    },
  });
  clients.push(client);

  let renderer: TestRenderer.ReactTestRenderer | null = null;
  await act(async () => {
    renderer = TestRenderer.create(
      <QueryClientProvider client={client}>{element}</QueryClientProvider>,
    );
  });
  await flush();

  if (renderer === null) throw new Error('renderer was not created');
  const created: TestRenderer.ReactTestRenderer = renderer;
  renderers.push(created);
  return created;
}

/** Every string the band actually puts on screen. */
function renderedText(renderer: TestRenderer.ReactTestRenderer): string[] {
  const texts: string[] = [];
  const walk = (node: TestRenderer.ReactTestRendererJSON | string): void => {
    if (typeof node === 'string') {
      texts.push(node);
      return;
    }
    node.children?.forEach(walk);
  };

  const tree = renderer.toJSON();
  if (tree === null) return texts;
  (Array.isArray(tree) ? tree : [tree]).forEach(walk);
  return texts;
}

/**
 * Every pressable control in the band. Keying off the component type gives
 * exactly ONE instance per rendered control (matching on props alone also
 * catches the host view each one renders).
 */
function pressables(renderer: TestRenderer.ReactTestRenderer): ReactTestInstance[] {
  return renderer.root.findAllByType(TouchableOpacity);
}

/** The dismiss control for one suggestion, found by its accessible name. */
function dismissButton(
  renderer: TestRenderer.ReactTestRenderer,
  name: string,
): ReactTestInstance {
  const label = mockTranslate('feed.interstitial.users.dismiss', { name });
  const matches = pressables(renderer).filter(
    (node) => node.props.accessibilityLabel === label,
  );
  if (matches.length !== 1) {
    throw new Error(`expected exactly one "${label}" control, found ${matches.length}`);
  }
  return matches[0];
}

/** Every dismiss control in the band (one per suggestion). */
function dismissButtonCount(renderer: TestRenderer.ReactTestRenderer): number {
  return pressables(renderer).filter(
    (node) =>
      typeof node.props.accessibilityLabel === 'string' &&
      node.props.accessibilityLabel.startsWith('Dismiss '),
  ).length;
}

/** The mobile carousel is the ONLY horizontal scroller a band renders. */
function horizontalScrollers(renderer: TestRenderer.ReactTestRenderer): ReactTestInstance[] {
  return renderer.root.findAllByType(ScrollView).filter((node) => node.props.horizontal === true);
}

/** The desktop header's "See more" link (the carousel uses a card instead). */
function seeMoreLinks(renderer: TestRenderer.ReactTestRenderer): ReactTestInstance[] {
  return renderer.root.findAll(
    (node) => typeof node.type === 'string' && node.props.accessibilityRole === 'link',
  );
}

/** `FeedSubscribeButton` is the only control in a band reporting selected + busy. */
function isSubscribeState(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    'selected' in value &&
    'busy' in value &&
    typeof value.selected === 'boolean' &&
    typeof value.busy === 'boolean'
  );
}

/** The Subscribe pills, in render order (one per suggested feed). */
function subscribeButtons(renderer: TestRenderer.ReactTestRenderer): ReactTestInstance[] {
  return pressables(renderer).filter((node) => isSubscribeState(node.props.accessibilityState));
}

/** The "Follow all" buttons, in render order (one per starter pack). */
function followAllButtons(renderer: TestRenderer.ReactTestRenderer): ReactTestInstance[] {
  const label = mockTranslate('feed.interstitial.starterPacks.followAll');
  return pressables(renderer).filter((node) => node.props.accessibilityLabel === label);
}

function press(node: ReactTestInstance): void {
  const onPress: unknown = node.props.onPress;
  if (typeof onPress !== 'function') throw new Error('node has no onPress');
  act(() => {
    onPress();
  });
}

const TITLES: Record<FeedInterstitialKind, string> = {
  suggestedUsers: 'Who to follow',
  suggestedFeeds: 'Suggested feeds',
  suggestedStarterPacks: 'Starter packs for you',
};

beforeEach(() => {
  mockIsDesktop = true;
  mockRecommendations = [];
  mockRecommendationsLoading = false;
  mockGetMarketplace.mockReset().mockResolvedValue({ items: [], total: 0 });
  mockLikeFeed.mockReset().mockResolvedValue({ liked: true });
  mockListStarterPacks.mockReset().mockResolvedValue({ items: [], total: 0 });
  mockUseStarterPack.mockReset().mockResolvedValue({ ok: true });
});

afterEach(() => {
  act(() => {
    renderers.forEach((renderer) => renderer.unmount());
  });
  renderers.length = 0;
  clients.forEach((client) => client.clear());
  clients.length = 0;
});

// ── Who to follow ───────────────────────────────────────────────────────────

describe('SuggestedUsersInterstitial', () => {
  it('renders NOTHING — no header, no border — when there are no recommendations', async () => {
    mockRecommendations = [];

    const renderer = await renderBand(<SuggestedUsersInterstitial ordinal={0} />);

    expect(renderer.toJSON()).toBeNull();
  });

  it('renders nothing below the desktop minimum of 3', async () => {
    mockRecommendations = users(2);

    const renderer = await renderBand(<SuggestedUsersInterstitial ordinal={0} />);

    expect(renderer.toJSON()).toBeNull();
  });

  it('renders nothing below the mobile minimum of 4 — the same 3 that suffice on desktop', async () => {
    mockIsDesktop = false;
    mockRecommendations = users(3);

    const mobile = await renderBand(<SuggestedUsersInterstitial ordinal={0} />);
    expect(mobile.toJSON()).toBeNull();

    mockIsDesktop = true;
    const desktop = await renderBand(<SuggestedUsersInterstitial ordinal={0} />);
    expect(renderedText(desktop)).toContain(TITLES.suggestedUsers);
  });

  it('holds the band open on placeholders while the recommendations are still loading', async () => {
    mockRecommendations = [];
    mockRecommendationsLoading = true;

    const renderer = await renderBand(<SuggestedUsersInterstitial ordinal={0} />);

    // The header stands on skeletons — the suggestions almost always arrive, and
    // popping the band in afterwards would shift the feed under the reader.
    expect(renderedText(renderer)).toContain(TITLES.suggestedUsers);
    expect(renderer.root.findAll((node) => node.props.testID === 'skeleton').length).toBeGreaterThan(
      0,
    );
    expect(dismissButtonCount(renderer)).toBe(0);
  });

  it('renders the header and every suggested account once it has enough', async () => {
    mockRecommendations = users(3);

    const renderer = await renderBand(<SuggestedUsersInterstitial ordinal={0} />);
    const text = renderedText(renderer);

    expect(text).toContain(TITLES.suggestedUsers);
    expect(text).toContain('Person 1');
    expect(text).toContain('Person 2');
    expect(text).toContain('Person 3');
    expect(dismissButtonCount(renderer)).toBe(3);
  });

  it('caps the band at maxItems and offsets the next band past them', async () => {
    mockRecommendations = users(12);

    const first = await renderBand(<SuggestedUsersInterstitial ordinal={0} />);
    // Desktop shows 5; the 6th account belongs to the next band.
    expect(dismissButtonCount(first)).toBe(5);
    expect(renderedText(first)).toContain('Person 5');
    expect(renderedText(first)).not.toContain('Person 6');

    const second = await renderBand(<SuggestedUsersInterstitial ordinal={1} />);
    expect(renderedText(second)).toContain('Person 6');
    expect(renderedText(second)).not.toContain('Person 5');
  });

  it('renders a vertical list on desktop — no carousel, a "See more" link in the header', async () => {
    mockIsDesktop = true;
    mockRecommendations = users(5);

    const renderer = await renderBand(<SuggestedUsersInterstitial ordinal={0} />);

    expect(horizontalScrollers(renderer)).toHaveLength(0);
    expect(seeMoreLinks(renderer)).toHaveLength(1);
    expect(renderedText(renderer)).toContain('See more');
  });

  it('renders a horizontal carousel on mobile — no header link, a trailing "See more" card', async () => {
    mockIsDesktop = false;
    mockRecommendations = users(5);

    const renderer = await renderBand(<SuggestedUsersInterstitial ordinal={0} />);

    const carousels = horizontalScrollers(renderer);
    expect(carousels).toHaveLength(1);
    // The carousel snaps by a whole card and every suggestion is a fixed-width
    // card inside it — the vertical list has neither.
    expect(carousels[0].props.snapToInterval).toBe(296 + 12);
    expect(seeMoreLinks(renderer)).toHaveLength(0);
    expect(renderedText(renderer)).toContain('See more');
  });

  it('removes a dismissed account from the band', async () => {
    mockRecommendations = users(4);

    const renderer = await renderBand(<SuggestedUsersInterstitial ordinal={0} />);
    expect(renderedText(renderer)).toContain('Person 2');

    press(dismissButton(renderer, 'Person 2'));

    const text = renderedText(renderer);
    expect(text).not.toContain('Person 2');
    expect(text).toContain('Person 1');
    expect(text).toContain('Person 3');
    expect(text).toContain('Person 4');
    expect(dismissButtonCount(renderer)).toBe(3);
  });

  it('backfills a dismissal from further down the pool instead of shrinking the band', async () => {
    mockRecommendations = users(12);

    const renderer = await renderBand(<SuggestedUsersInterstitial ordinal={0} />);
    expect(renderedText(renderer)).not.toContain('Person 6');

    press(dismissButton(renderer, 'Person 2'));

    const text = renderedText(renderer);
    expect(text).not.toContain('Person 2');
    // The band stays full: the 6th account slides up into the freed slot.
    expect(text).toContain('Person 6');
    expect(dismissButtonCount(renderer)).toBe(5);
  });

  it('disappears entirely once dismissals drain it below the minimum', async () => {
    mockRecommendations = users(4);

    const renderer = await renderBand(<SuggestedUsersInterstitial ordinal={0} />);

    press(dismissButton(renderer, 'Person 1'));
    // 3 left — still at the desktop minimum, so the band stands.
    expect(dismissButtonCount(renderer)).toBe(3);
    expect(renderedText(renderer)).toContain(TITLES.suggestedUsers);

    press(dismissButton(renderer, 'Person 2'));

    // 2 left: below the minimum. Not an empty band, not a lone header — nothing.
    expect(renderer.toJSON()).toBeNull();
  });

  it('dismisses from the mobile carousel too, and closes the band below the mobile minimum', async () => {
    mockIsDesktop = false;
    mockRecommendations = users(4);

    const renderer = await renderBand(<SuggestedUsersInterstitial ordinal={0} />);
    expect(horizontalScrollers(renderer)).toHaveLength(1);
    expect(dismissButtonCount(renderer)).toBe(4);

    press(dismissButton(renderer, 'Person 3'));

    // 3 left — enough for desktop, but the mobile carousel needs 4.
    expect(renderer.toJSON()).toBeNull();
  });
});

// ── Suggested feeds ─────────────────────────────────────────────────────────

describe('SuggestedFeedsInterstitial', () => {
  it('renders nothing when the marketplace comes back empty', async () => {
    mockGetMarketplace.mockResolvedValue({ items: [], total: 0 });

    const renderer = await renderBand(<SuggestedFeedsInterstitial ordinal={0} />);

    expect(renderer.toJSON()).toBeNull();
  });

  it('renders nothing below the minimum', async () => {
    mockGetMarketplace.mockResolvedValue({ items: feeds(2), total: 2 });

    const renderer = await renderBand(<SuggestedFeedsInterstitial ordinal={0} />);

    expect(renderer.toJSON()).toBeNull();
  });

  it('renders the header and every suggested feed once it has enough', async () => {
    mockGetMarketplace.mockResolvedValue({ items: feeds(3), total: 3 });

    const renderer = await renderBand(<SuggestedFeedsInterstitial ordinal={0} />);
    const text = renderedText(renderer);

    expect(text).toContain(TITLES.suggestedFeeds);
    expect(text).toContain('Feed 1');
    expect(text).toContain('Feed 2');
    expect(text).toContain('Feed 3');
    expect(dismissButtonCount(renderer)).toBe(3);
  });

  it('asks the marketplace to exclude what the viewer already subscribes to', async () => {
    mockGetMarketplace.mockResolvedValue({ items: feeds(3), total: 3 });

    await renderBand(<SuggestedFeedsInterstitial ordinal={0} />);

    expect(mockGetMarketplace).toHaveBeenCalledWith(
      expect.objectContaining({ excludeSubscribed: true }),
    );
  });

  it('renders a vertical list on desktop and a horizontal carousel on mobile', async () => {
    mockGetMarketplace.mockResolvedValue({ items: feeds(6), total: 6 });

    mockIsDesktop = true;
    const desktop = await renderBand(<SuggestedFeedsInterstitial ordinal={0} />);
    expect(horizontalScrollers(desktop)).toHaveLength(0);
    expect(seeMoreLinks(desktop)).toHaveLength(1);

    mockIsDesktop = false;
    const mobile = await renderBand(<SuggestedFeedsInterstitial ordinal={0} />);
    expect(horizontalScrollers(mobile)).toHaveLength(1);
    expect(seeMoreLinks(mobile)).toHaveLength(0);
  });

  it('removes a dismissed feed, and closes the band once too few are left', async () => {
    mockGetMarketplace.mockResolvedValue({ items: feeds(4), total: 4 });

    const renderer = await renderBand(<SuggestedFeedsInterstitial ordinal={0} />);
    // Desktop shows 3 of the 4 available feeds.
    expect(dismissButtonCount(renderer)).toBe(3);
    expect(renderedText(renderer)).not.toContain('Feed 4');

    press(dismissButton(renderer, 'Feed 1'));

    // The 4th feed backfills the dismissed one — the band is still full.
    const text = renderedText(renderer);
    expect(text).not.toContain('Feed 1');
    expect(text).toContain('Feed 4');
    expect(dismissButtonCount(renderer)).toBe(3);

    press(dismissButton(renderer, 'Feed 2'));

    // Nothing left to backfill with: 2 feeds, below the minimum of 3. The band
    // disappears rather than shrink to a stub.
    expect(renderer.toJSON()).toBeNull();
  });

  it('subscribes to the feed the viewer pressed — and only that one', async () => {
    mockGetMarketplace.mockResolvedValue({ items: feeds(3), total: 3 });

    const renderer = await renderBand(<SuggestedFeedsInterstitial ordinal={0} />);
    const buttons = subscribeButtons(renderer);
    expect(buttons).toHaveLength(3);
    expect(renderedText(renderer).filter((text) => text === 'Subscribe')).toHaveLength(3);

    // The SECOND card: a per-item callback that captured the wrong id would
    // subscribe to Feed 1 or Feed 3 here.
    press(buttons[1]);
    await flush();

    expect(mockLikeFeed).toHaveBeenCalledTimes(1);
    expect(mockLikeFeed).toHaveBeenCalledWith('f2');

    const text = renderedText(renderer);
    expect(text.filter((entry) => entry === 'Subscribed')).toHaveLength(1);
    expect(text.filter((entry) => entry === 'Subscribe')).toHaveLength(2);
    // Subscribing is not dismissing: the feed stays in the band.
    expect(text).toContain('Feed 2');
  });

  it('renders nothing for a settled anonymous viewer (the server never plans a band for one)', async () => {
    mockGetMarketplace.mockResolvedValue({ items: feeds(6), total: 6 });
    const previous = { ...mockAuth };
    mockAuth.canUsePrivateApi = false;
    mockAuth.isPrivateApiPending = false;

    try {
      const renderer = await renderBand(<SuggestedFeedsInterstitial ordinal={0} />);

      expect(renderer.toJSON()).toBeNull();
      expect(mockGetMarketplace).not.toHaveBeenCalled();
    } finally {
      mockAuth.canUsePrivateApi = previous.canUsePrivateApi;
      mockAuth.isPrivateApiPending = previous.isPrivateApiPending;
    }
  });
});

// ── Starter packs ───────────────────────────────────────────────────────────

describe('SuggestedStarterPacksInterstitial', () => {
  it('renders nothing when there are no packs to suggest', async () => {
    mockListStarterPacks.mockResolvedValue({ items: [], total: 0 });

    const renderer = await renderBand(<SuggestedStarterPacksInterstitial ordinal={0} />);

    expect(renderer.toJSON()).toBeNull();
  });

  it('renders nothing below the minimum', async () => {
    mockListStarterPacks.mockResolvedValue({ items: packs(2), total: 2 });

    const renderer = await renderBand(<SuggestedStarterPacksInterstitial ordinal={0} />);

    expect(renderer.toJSON()).toBeNull();
  });

  it('renders the header and every suggested pack once it has enough', async () => {
    mockListStarterPacks.mockResolvedValue({ items: packs(3), total: 3 });

    const renderer = await renderBand(<SuggestedStarterPacksInterstitial ordinal={0} />);
    const text = renderedText(renderer);

    expect(text).toContain(TITLES.suggestedStarterPacks);
    expect(text).toContain('Pack 1');
    expect(text).toContain('Pack 2');
    expect(text).toContain('Pack 3');
    expect(dismissButtonCount(renderer)).toBe(3);
  });

  it('asks the API to exclude packs the viewer already used', async () => {
    mockListStarterPacks.mockResolvedValue({ items: packs(3), total: 3 });

    await renderBand(<SuggestedStarterPacksInterstitial ordinal={0} />);

    expect(mockListStarterPacks).toHaveBeenCalledWith(
      expect.objectContaining({ excludeUsed: true }),
    );
  });

  it('records the pack as used when the viewer follows all of its members', async () => {
    mockListStarterPacks.mockResolvedValue({ items: packs(3), total: 3 });

    const renderer = await renderBand(<SuggestedStarterPacksInterstitial ordinal={0} />);
    const buttons = followAllButtons(renderer);
    expect(buttons).toHaveLength(3);

    // The SECOND pack — a callback closing over the wrong pack would record p1/p3.
    press(buttons[1]);
    await flush();

    expect(mockUseStarterPack).toHaveBeenCalledTimes(1);
    expect(mockUseStarterPack).toHaveBeenCalledWith('p2');
  });

  it('offers no "Follow all" for a pack with no members to follow', async () => {
    mockListStarterPacks.mockResolvedValue({
      items: packs(3).map((pack) => ({ ...pack, memberOxyUserIds: [], memberCount: 0 })),
      total: 3,
    });

    const renderer = await renderBand(<SuggestedStarterPacksInterstitial ordinal={0} />);

    // The packs still render — but with no dead call-to-action under them.
    expect(renderedText(renderer)).toContain('Pack 1');
    expect(followAllButtons(renderer)).toHaveLength(0);
  });

  it('renders a vertical list on desktop and a horizontal carousel on mobile', async () => {
    mockListStarterPacks.mockResolvedValue({ items: packs(6), total: 6 });

    mockIsDesktop = true;
    const desktop = await renderBand(<SuggestedStarterPacksInterstitial ordinal={0} />);
    expect(horizontalScrollers(desktop)).toHaveLength(0);
    expect(seeMoreLinks(desktop)).toHaveLength(1);

    mockIsDesktop = false;
    const mobile = await renderBand(<SuggestedStarterPacksInterstitial ordinal={0} />);
    expect(horizontalScrollers(mobile)).toHaveLength(1);
    expect(seeMoreLinks(mobile)).toHaveLength(0);
  });

  it('removes a dismissed pack, and closes the band once too few are left', async () => {
    mockListStarterPacks.mockResolvedValue({ items: packs(4), total: 4 });

    const renderer = await renderBand(<SuggestedStarterPacksInterstitial ordinal={0} />);
    // Desktop shows 3 of the 4 available packs.
    expect(dismissButtonCount(renderer)).toBe(3);
    expect(renderedText(renderer)).not.toContain('Pack 4');

    press(dismissButton(renderer, 'Pack 1'));

    // The 4th pack backfills the dismissed one — the band is still full.
    const text = renderedText(renderer);
    expect(text).not.toContain('Pack 1');
    expect(text).toContain('Pack 4');
    expect(dismissButtonCount(renderer)).toBe(3);

    press(dismissButton(renderer, 'Pack 2'));

    // 2 packs left, below the minimum of 3: the band disappears entirely.
    expect(renderer.toJSON()).toBeNull();
  });
});

// ── Dispatch ────────────────────────────────────────────────────────────────

describe('FeedInterstitial', () => {
  function slot(kind: FeedInterstitialKind): FeedInterstitialSlot {
    return { key: `slot-${kind}`, kind, afterSliceKey: 'slice-1' };
  }

  beforeEach(() => {
    mockRecommendations = users(5);
    mockGetMarketplace.mockResolvedValue({ items: feeds(5), total: 5 });
    mockListStarterPacks.mockResolvedValue({ items: packs(5), total: 5 });
  });

  it('dispatches suggestedUsers to the who-to-follow band', async () => {
    const renderer = await renderBand(<FeedInterstitial slot={slot('suggestedUsers')} ordinal={0} />);
    const text = renderedText(renderer);

    expect(text).toContain(TITLES.suggestedUsers);
    expect(text).toContain('Person 1');
    expect(text).not.toContain(TITLES.suggestedFeeds);
    expect(text).not.toContain(TITLES.suggestedStarterPacks);
  });

  it('dispatches suggestedFeeds to the feeds band', async () => {
    const renderer = await renderBand(<FeedInterstitial slot={slot('suggestedFeeds')} ordinal={0} />);
    const text = renderedText(renderer);

    expect(text).toContain(TITLES.suggestedFeeds);
    expect(text).toContain('Feed 1');
    expect(text).not.toContain(TITLES.suggestedUsers);
    expect(text).not.toContain(TITLES.suggestedStarterPacks);
  });

  it('dispatches suggestedStarterPacks to the starter-packs band', async () => {
    const renderer = await renderBand(
      <FeedInterstitial slot={slot('suggestedStarterPacks')} ordinal={0} />,
    );
    const text = renderedText(renderer);

    expect(text).toContain(TITLES.suggestedStarterPacks);
    expect(text).toContain('Pack 1');
    expect(text).not.toContain(TITLES.suggestedUsers);
    expect(text).not.toContain(TITLES.suggestedFeeds);
  });

  it('passes the ordinal through, so a second band of the same kind shows different accounts', async () => {
    mockRecommendations = users(12);

    const first = await renderBand(<FeedInterstitial slot={slot('suggestedUsers')} ordinal={0} />);
    const second = await renderBand(<FeedInterstitial slot={slot('suggestedUsers')} ordinal={1} />);

    expect(renderedText(first)).toContain('Person 1');
    expect(renderedText(second)).not.toContain('Person 1');
    expect(renderedText(second)).toContain('Person 6');
  });
});
