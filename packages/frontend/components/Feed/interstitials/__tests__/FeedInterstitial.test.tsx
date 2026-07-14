import React from 'react';
import { ScrollView, TouchableOpacity } from 'react-native';
import TestRenderer, { act, type ReactTestInstance } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type {
  FeedInterstitialEventInput,
  FeedInterstitialKind,
  FeedInterstitialSlot,
} from '@mention/shared-types';
import type { User } from '@oxyhq/core';
import type { ProfileData } from '@/lib/recommendations';
import type { MarketplaceFeed } from '@/services/customFeedsService';
import type { StarterPackSummary } from '@/services/starterPacksService';
import enMessages from '@/locales/en.json';

import FeedInterstitial from '../FeedInterstitial';
import { SimilarAccountsInterstitial } from '../SimilarAccountsInterstitial';
import { SuggestedFeedsInterstitial } from '../SuggestedFeedsInterstitial';
import { SuggestedStarterPacksInterstitial } from '../SuggestedStarterPacksInterstitial';
import { SuggestedUsersInterstitial } from '../SuggestedUsersInterstitial';

/**
 * Render + telemetry tests for the four feed recommendation bands.
 *
 * The contract every band shares — and the one the pure-layout tests
 * (`interstitialLayout.test.ts`) can only prove half of — is that a band with
 * too little to say renders NOTHING: not an empty band, not a lone header, not
 * a stray border. These tests drive the real components through the real
 * `InterstitialShell` and assert on the rendered tree.
 *
 * The second contract is that the bands are MEASURED: every card reports what
 * the viewer did with it, to the card endpoint and never to the post-interaction
 * one. That is asserted at the `feedService` boundary, where the two routes are
 * two different methods.
 *
 * Mocks stop at the module boundary the band talks to: the data hooks/services
 * that fetch suggestions, the responsive hook that decides the layout, and the
 * SDK packages (`@oxyhq/services`, `@oxyhq/bloom`) that ship untranspiled TS
 * source. Everything from the interstitial down to the `ProfileCard` /
 * `FeedCard` / `StarterPackCard` rows — including the real telemetry module,
 * the dismiss buttons and the carousel — is the component under test.
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

/** The similar-accounts band resolves its suggestions through the SDK client. */
const mockGetSimilarProfiles = jest.fn();
const mockGetUsersByIds = jest.fn();

/** The band asks for the viewer + private-API readiness; nothing else. */
const mockAuth = {
  user: { id: 'viewer-1' },
  canUsePrivateApi: true,
  isPrivateApiPending: false,
  oxyServices: {
    getSimilarProfiles: (...args: unknown[]) => mockGetSimilarProfiles(...args),
    getUsersByIds: (...args: unknown[]) => mockGetUsersByIds(...args),
  },
};

interface FollowButtonProps {
  /** Multi-user mode (starter packs): "follow all these accounts". */
  userIds?: string[];
  /** Single-user mode (the profile row). */
  userId?: string;
  followAllLabel?: string;
  onBulkFollow?: () => void;
  onFollowChange?: (isFollowing: boolean) => void;
}

/** The accessible name of the single-user follow control in the mocked SDK. */
const FOLLOW_LABEL = 'Follow';

jest.mock('@oxyhq/services', () => {
  const { Text, TouchableOpacity } =
    jest.requireActual<typeof import('react-native')>('react-native');
  return {
    useAuth: () => mockAuth,
    // The real cache keys, ported: the bands' profile precaching writes through
    // them, so a stub object would throw the moment a band primed the cache.
    queryKeys: {
      users: {
        detail: (id: string) => ['users', 'detail', id],
        details: () => ['users', 'detail'],
      },
    },
    // Faithful to the two modes the real button has, including the one behavior
    // the starter-pack band depends on: in multi-user mode with nobody left to
    // follow it renders NOTHING, so a pack the viewer already followed through
    // shows no dead call-to-action. Both modes report through their callback —
    // the button owns the follow state, so that callback is the only way a band
    // can learn a suggestion was acted on.
    FollowButton: ({
      userIds,
      followAllLabel,
      onBulkFollow,
      onFollowChange,
    }: FollowButtonProps) => {
      if (userIds === undefined) {
        return (
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityLabel={FOLLOW_LABEL}
            onPress={() => onFollowChange?.(true)}>
            <Text>{FOLLOW_LABEL}</Text>
          </TouchableOpacity>
        );
      }
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
 * The telemetry transport. The REAL `utils/feedTelemetry` runs on top of it, so
 * these two spies are exactly the two routes the app can reach: card events must
 * land on `sendInterstitialEvent` and NEVER on `sendFeedInteraction`, which
 * carries a `postUri` and feeds post ranking.
 */
const mockSendInterstitialEvent = jest.fn();
const mockSendFeedInteraction = jest.fn();
jest.mock('@/services/feedService', () => ({
  feedService: {
    sendInterstitialEvent: (...args: unknown[]) => mockSendInterstitialEvent(...args),
    sendFeedInteraction: (...args: unknown[]) => mockSendFeedInteraction(...args),
  },
}));

/** The subject of the similar-accounts band, read from the shared actor cache. */
let mockSubject: User | undefined;
jest.mock('@/hooks/useCachedUser', () => ({
  useUserById: () => mockSubject,
}));

/**
 * The app's singleton actor cache, which the bands prime with the profiles they
 * fetch. Swapped for a throwaway client: priming the REAL one arms its
 * 30-minute garbage-collection timer, which outlives the test run and holds
 * jest's worker open.
 */
jest.mock('@/lib/queryClient', () => {
  const { QueryClient } =
    jest.requireActual<typeof import('@tanstack/react-query')>('@tanstack/react-query');
  return { queryClient: new QueryClient({ defaultOptions: { queries: { gcTime: 0 } } }) };
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

/** The slot the bands under test were planned for, and the feed they sit in. */
const SLOT_KEY = 'slot-1';
const FEED_DESCRIPTOR = 'for_you';

/** What the dispatcher hands a band about the slot it occupies. */
const inFeed = { slotKey: SLOT_KEY, feedDescriptor: FEED_DESCRIPTOR };

/** The profile a similar-accounts band is ABOUT. */
const SUBJECT_ID = 'subject-1';

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

/** `count` accounts similar to the subject: Similar 1, … (`s1`, `s2`, …). */
function similarAccounts(count: number): User[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `s${index + 1}`,
    publicKey: `key-${index + 1}`,
    username: `similar${index + 1}`,
    name: { displayName: `Similar ${index + 1}` },
    avatar: `avatar-${index + 1}`,
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

/**
 * The pressable "See more" control — the header link on desktop, the trailing
 * carousel card on mobile. (`seeMoreLinks` matches the rendered host node, which
 * carries the accessible role but not the press handler.)
 */
function seeMoreButtons(renderer: TestRenderer.ReactTestRenderer): ReactTestInstance[] {
  const label = mockTranslate('feed.interstitial.seeMore');
  return pressables(renderer).filter((node) => node.props.accessibilityLabel === label);
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

/** The per-account follow buttons, in render order (one per profile row). */
function followButtons(renderer: TestRenderer.ReactTestRenderer): ReactTestInstance[] {
  return pressables(renderer).filter((node) => node.props.accessibilityLabel === FOLLOW_LABEL);
}

/**
 * The pressable region of a profile row — the account itself, as opposed to the
 * follow/dismiss controls beside it. It is the only control in a band whose
 * accessible role is a button and which carries no accessible name of its own.
 */
function profileRowPressables(
  renderer: TestRenderer.ReactTestRenderer,
): ReactTestInstance[] {
  return pressables(renderer).filter(
    (node) =>
      node.props.accessibilityRole === 'button' &&
      node.props.accessibilityLabel === undefined,
  );
}

function press(node: ReactTestInstance): void {
  const onPress: unknown = node.props.onPress;
  if (typeof onPress !== 'function') throw new Error('node has no onPress');
  act(() => {
    onPress();
  });
}

/** Every card event the bands reported, in order. */
function reportedEvents(): FeedInterstitialEventInput[] {
  return mockSendInterstitialEvent.mock.calls.map(([input]) => input as FeedInterstitialEventInput);
}

const TITLES: Record<FeedInterstitialKind, string> = {
  suggestedUsers: 'Who to follow',
  suggestedFeeds: 'Suggested feeds',
  suggestedStarterPacks: 'Starter packs for you',
  similarAccounts: 'Similar accounts',
};

beforeEach(() => {
  mockIsDesktop = true;
  mockRecommendations = [];
  mockRecommendationsLoading = false;
  mockGetMarketplace.mockReset().mockResolvedValue({ items: [], total: 0 });
  mockLikeFeed.mockReset().mockResolvedValue({ liked: true });
  mockListStarterPacks.mockReset().mockResolvedValue({ items: [], total: 0 });
  mockUseStarterPack.mockReset().mockResolvedValue({ ok: true });
  mockGetSimilarProfiles.mockReset().mockResolvedValue([]);
  mockGetUsersByIds.mockReset().mockResolvedValue([]);
  mockSendInterstitialEvent.mockReset().mockResolvedValue(undefined);
  mockSendFeedInteraction.mockReset().mockResolvedValue(undefined);
  mockSubject = undefined;
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

    const renderer = await renderBand(<SuggestedUsersInterstitial {...inFeed} ordinal={0} />);

    expect(renderer.toJSON()).toBeNull();
  });

  it('renders nothing below the desktop minimum of 3', async () => {
    mockRecommendations = users(2);

    const renderer = await renderBand(<SuggestedUsersInterstitial {...inFeed} ordinal={0} />);

    expect(renderer.toJSON()).toBeNull();
  });

  it('renders nothing below the mobile minimum of 4 — the same 3 that suffice on desktop', async () => {
    mockIsDesktop = false;
    mockRecommendations = users(3);

    const mobile = await renderBand(<SuggestedUsersInterstitial {...inFeed} ordinal={0} />);
    expect(mobile.toJSON()).toBeNull();

    mockIsDesktop = true;
    const desktop = await renderBand(<SuggestedUsersInterstitial {...inFeed} ordinal={0} />);
    expect(renderedText(desktop)).toContain(TITLES.suggestedUsers);
  });

  it('holds the band open on placeholders while the recommendations are still loading', async () => {
    mockRecommendations = [];
    mockRecommendationsLoading = true;

    const renderer = await renderBand(<SuggestedUsersInterstitial {...inFeed} ordinal={0} />);

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

    const renderer = await renderBand(<SuggestedUsersInterstitial {...inFeed} ordinal={0} />);
    const text = renderedText(renderer);

    expect(text).toContain(TITLES.suggestedUsers);
    expect(text).toContain('Person 1');
    expect(text).toContain('Person 2');
    expect(text).toContain('Person 3');
    expect(dismissButtonCount(renderer)).toBe(3);
  });

  it('caps the band at maxItems and offsets the next band past them', async () => {
    mockRecommendations = users(12);

    const first = await renderBand(<SuggestedUsersInterstitial {...inFeed} ordinal={0} />);
    // Desktop shows 5; the 6th account belongs to the next band.
    expect(dismissButtonCount(first)).toBe(5);
    expect(renderedText(first)).toContain('Person 5');
    expect(renderedText(first)).not.toContain('Person 6');

    const second = await renderBand(<SuggestedUsersInterstitial {...inFeed} ordinal={1} />);
    expect(renderedText(second)).toContain('Person 6');
    expect(renderedText(second)).not.toContain('Person 5');
  });

  it('renders a vertical list on desktop — no carousel, a "See more" link in the header', async () => {
    mockIsDesktop = true;
    mockRecommendations = users(5);

    const renderer = await renderBand(<SuggestedUsersInterstitial {...inFeed} ordinal={0} />);

    expect(horizontalScrollers(renderer)).toHaveLength(0);
    expect(seeMoreLinks(renderer)).toHaveLength(1);
    expect(renderedText(renderer)).toContain('See more');
  });

  it('renders a horizontal carousel on mobile — no header link, a trailing "See more" card', async () => {
    mockIsDesktop = false;
    mockRecommendations = users(5);

    const renderer = await renderBand(<SuggestedUsersInterstitial {...inFeed} ordinal={0} />);

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

    const renderer = await renderBand(<SuggestedUsersInterstitial {...inFeed} ordinal={0} />);
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

    const renderer = await renderBand(<SuggestedUsersInterstitial {...inFeed} ordinal={0} />);
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

    const renderer = await renderBand(<SuggestedUsersInterstitial {...inFeed} ordinal={0} />);

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

    const renderer = await renderBand(<SuggestedUsersInterstitial {...inFeed} ordinal={0} />);
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

    const renderer = await renderBand(<SuggestedFeedsInterstitial {...inFeed} ordinal={0} />);

    expect(renderer.toJSON()).toBeNull();
  });

  it('renders nothing below the minimum', async () => {
    mockGetMarketplace.mockResolvedValue({ items: feeds(2), total: 2 });

    const renderer = await renderBand(<SuggestedFeedsInterstitial {...inFeed} ordinal={0} />);

    expect(renderer.toJSON()).toBeNull();
  });

  it('renders the header and every suggested feed once it has enough', async () => {
    mockGetMarketplace.mockResolvedValue({ items: feeds(3), total: 3 });

    const renderer = await renderBand(<SuggestedFeedsInterstitial {...inFeed} ordinal={0} />);
    const text = renderedText(renderer);

    expect(text).toContain(TITLES.suggestedFeeds);
    expect(text).toContain('Feed 1');
    expect(text).toContain('Feed 2');
    expect(text).toContain('Feed 3');
    expect(dismissButtonCount(renderer)).toBe(3);
  });

  it('asks the marketplace to exclude what the viewer already subscribes to', async () => {
    mockGetMarketplace.mockResolvedValue({ items: feeds(3), total: 3 });

    await renderBand(<SuggestedFeedsInterstitial {...inFeed} ordinal={0} />);

    expect(mockGetMarketplace).toHaveBeenCalledWith(
      expect.objectContaining({ excludeSubscribed: true }),
    );
  });

  it('renders a vertical list on desktop and a horizontal carousel on mobile', async () => {
    mockGetMarketplace.mockResolvedValue({ items: feeds(6), total: 6 });

    mockIsDesktop = true;
    const desktop = await renderBand(<SuggestedFeedsInterstitial {...inFeed} ordinal={0} />);
    expect(horizontalScrollers(desktop)).toHaveLength(0);
    expect(seeMoreLinks(desktop)).toHaveLength(1);

    mockIsDesktop = false;
    const mobile = await renderBand(<SuggestedFeedsInterstitial {...inFeed} ordinal={0} />);
    expect(horizontalScrollers(mobile)).toHaveLength(1);
    expect(seeMoreLinks(mobile)).toHaveLength(0);
  });

  it('removes a dismissed feed, and closes the band once too few are left', async () => {
    mockGetMarketplace.mockResolvedValue({ items: feeds(4), total: 4 });

    const renderer = await renderBand(<SuggestedFeedsInterstitial {...inFeed} ordinal={0} />);
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

    const renderer = await renderBand(<SuggestedFeedsInterstitial {...inFeed} ordinal={0} />);
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
      const renderer = await renderBand(<SuggestedFeedsInterstitial {...inFeed} ordinal={0} />);

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

    const renderer = await renderBand(<SuggestedStarterPacksInterstitial {...inFeed} ordinal={0} />);

    expect(renderer.toJSON()).toBeNull();
  });

  it('renders nothing below the minimum', async () => {
    mockListStarterPacks.mockResolvedValue({ items: packs(2), total: 2 });

    const renderer = await renderBand(<SuggestedStarterPacksInterstitial {...inFeed} ordinal={0} />);

    expect(renderer.toJSON()).toBeNull();
  });

  it('renders the header and every suggested pack once it has enough', async () => {
    mockListStarterPacks.mockResolvedValue({ items: packs(3), total: 3 });

    const renderer = await renderBand(<SuggestedStarterPacksInterstitial {...inFeed} ordinal={0} />);
    const text = renderedText(renderer);

    expect(text).toContain(TITLES.suggestedStarterPacks);
    expect(text).toContain('Pack 1');
    expect(text).toContain('Pack 2');
    expect(text).toContain('Pack 3');
    expect(dismissButtonCount(renderer)).toBe(3);
  });

  it('asks the API to exclude packs the viewer already used', async () => {
    mockListStarterPacks.mockResolvedValue({ items: packs(3), total: 3 });

    await renderBand(<SuggestedStarterPacksInterstitial {...inFeed} ordinal={0} />);

    expect(mockListStarterPacks).toHaveBeenCalledWith(
      expect.objectContaining({ excludeUsed: true }),
    );
  });

  it('records the pack as used when the viewer follows all of its members', async () => {
    mockListStarterPacks.mockResolvedValue({ items: packs(3), total: 3 });

    const renderer = await renderBand(<SuggestedStarterPacksInterstitial {...inFeed} ordinal={0} />);
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

    const renderer = await renderBand(<SuggestedStarterPacksInterstitial {...inFeed} ordinal={0} />);

    // The packs still render — but with no dead call-to-action under them.
    expect(renderedText(renderer)).toContain('Pack 1');
    expect(followAllButtons(renderer)).toHaveLength(0);
  });

  it('renders a vertical list on desktop and a horizontal carousel on mobile', async () => {
    mockListStarterPacks.mockResolvedValue({ items: packs(6), total: 6 });

    mockIsDesktop = true;
    const desktop = await renderBand(<SuggestedStarterPacksInterstitial {...inFeed} ordinal={0} />);
    expect(horizontalScrollers(desktop)).toHaveLength(0);
    expect(seeMoreLinks(desktop)).toHaveLength(1);

    mockIsDesktop = false;
    const mobile = await renderBand(<SuggestedStarterPacksInterstitial {...inFeed} ordinal={0} />);
    expect(horizontalScrollers(mobile)).toHaveLength(1);
    expect(seeMoreLinks(mobile)).toHaveLength(0);
  });

  it('removes a dismissed pack, and closes the band once too few are left', async () => {
    mockListStarterPacks.mockResolvedValue({ items: packs(4), total: 4 });

    const renderer = await renderBand(<SuggestedStarterPacksInterstitial {...inFeed} ordinal={0} />);
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

// ── Similar accounts ────────────────────────────────────────────────────────

describe('SimilarAccountsInterstitial', () => {
  it('renders nothing when the subject has no similar accounts', async () => {
    mockGetSimilarProfiles.mockResolvedValue([]);

    const renderer = await renderBand(
      <SimilarAccountsInterstitial {...inFeed} ordinal={0} subjectId={SUBJECT_ID} />,
    );

    expect(renderer.toJSON()).toBeNull();
  });

  it('renders nothing below the minimum', async () => {
    mockGetSimilarProfiles.mockResolvedValue(similarAccounts(2));

    const renderer = await renderBand(
      <SimilarAccountsInterstitial {...inFeed} ordinal={0} subjectId={SUBJECT_ID} />,
    );

    expect(renderer.toJSON()).toBeNull();
  });

  it('renders nothing — and asks for nobody — with no subject to be similar to', async () => {
    mockGetSimilarProfiles.mockResolvedValue(similarAccounts(5));

    const renderer = await renderBand(
      <SimilarAccountsInterstitial {...inFeed} ordinal={0} subjectId={undefined} />,
    );

    // A card with no subject must not guess one (e.g. fall back to the viewer's
    // own recommendations): without a subject there is nothing to be similar to.
    expect(renderer.toJSON()).toBeNull();
    expect(mockGetSimilarProfiles).not.toHaveBeenCalled();
  });

  it("renders the header and the SUBJECT's similar accounts", async () => {
    mockGetSimilarProfiles.mockResolvedValue(similarAccounts(3));

    const renderer = await renderBand(
      <SimilarAccountsInterstitial {...inFeed} ordinal={0} subjectId={SUBJECT_ID} />,
    );
    const text = renderedText(renderer);

    expect(mockGetSimilarProfiles).toHaveBeenCalledWith(SUBJECT_ID);
    expect(text).toContain(TITLES.similarAccounts);
    expect(text).toContain('Similar 1');
    expect(text).toContain('Similar 2');
    expect(text).toContain('Similar 3');
    expect(dismissButtonCount(renderer)).toBe(3);
  });

  it('never suggests the subject as similar to itself', async () => {
    mockGetSimilarProfiles.mockResolvedValue([
      ...similarAccounts(3),
      { id: SUBJECT_ID, publicKey: 'k', username: 'subject', name: { displayName: 'The Subject' } },
    ]);

    const renderer = await renderBand(
      <SimilarAccountsInterstitial {...inFeed} ordinal={0} subjectId={SUBJECT_ID} />,
    );

    expect(renderedText(renderer)).not.toContain('The Subject');
    expect(dismissButtonCount(renderer)).toBe(3);
  });

  it('renders a vertical list on desktop and a horizontal carousel on mobile', async () => {
    mockGetSimilarProfiles.mockResolvedValue(similarAccounts(6));

    mockIsDesktop = true;
    const desktop = await renderBand(
      <SimilarAccountsInterstitial {...inFeed} ordinal={0} subjectId={SUBJECT_ID} />,
    );
    expect(horizontalScrollers(desktop)).toHaveLength(0);
    expect(seeMoreLinks(desktop)).toHaveLength(1);

    mockIsDesktop = false;
    const mobile = await renderBand(
      <SimilarAccountsInterstitial {...inFeed} ordinal={0} subjectId={SUBJECT_ID} />,
    );
    expect(horizontalScrollers(mobile)).toHaveLength(1);
    expect(seeMoreLinks(mobile)).toHaveLength(0);
  });

  it('removes a dismissed account, and closes the band once too few are left', async () => {
    mockGetSimilarProfiles.mockResolvedValue(similarAccounts(4));

    const renderer = await renderBand(
      <SimilarAccountsInterstitial {...inFeed} ordinal={0} subjectId={SUBJECT_ID} />,
    );
    expect(dismissButtonCount(renderer)).toBe(4);

    press(dismissButton(renderer, 'Similar 2'));

    const text = renderedText(renderer);
    expect(text).not.toContain('Similar 2');
    expect(text).toContain('Similar 1');
    expect(dismissButtonCount(renderer)).toBe(3);

    press(dismissButton(renderer, 'Similar 1'));

    // 2 left, below the desktop minimum of 3: the band disappears entirely.
    expect(renderer.toJSON()).toBeNull();
  });
});

// ── Dispatch ────────────────────────────────────────────────────────────────

describe('FeedInterstitial', () => {
  function slot(kind: FeedInterstitialKind, subjectId?: string): FeedInterstitialSlot {
    return { key: `slot-${kind}`, kind, afterSliceKey: 'slice-1', subjectId };
  }

  beforeEach(() => {
    mockRecommendations = users(5);
    mockGetMarketplace.mockResolvedValue({ items: feeds(5), total: 5 });
    mockListStarterPacks.mockResolvedValue({ items: packs(5), total: 5 });
    mockGetSimilarProfiles.mockResolvedValue(similarAccounts(5));
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

  it('dispatches similarAccounts to the similar-accounts band, with the slot subject', async () => {
    const renderer = await renderBand(
      <FeedInterstitial slot={slot('similarAccounts', SUBJECT_ID)} ordinal={0} />,
    );
    const text = renderedText(renderer);

    expect(mockGetSimilarProfiles).toHaveBeenCalledWith(SUBJECT_ID);
    expect(text).toContain(TITLES.similarAccounts);
    expect(text).toContain('Similar 1');
    expect(text).not.toContain(TITLES.suggestedUsers);
    expect(text).not.toContain(TITLES.suggestedFeeds);
    expect(text).not.toContain(TITLES.suggestedStarterPacks);
  });

  it('passes the ordinal through, so a second band of the same kind shows different accounts', async () => {
    mockRecommendations = users(12);

    const first = await renderBand(<FeedInterstitial slot={slot('suggestedUsers')} ordinal={0} />);
    const second = await renderBand(<FeedInterstitial slot={slot('suggestedUsers')} ordinal={1} />);

    expect(renderedText(first)).toContain('Person 1');
    expect(renderedText(second)).not.toContain('Person 1');
    expect(renderedText(second)).toContain('Person 6');
  });

  it('threads the feed descriptor into the card, so its events name the feed it interrupted', async () => {
    const renderer = await renderBand(
      <FeedInterstitial
        slot={slot('suggestedUsers')}
        ordinal={0}
        feedDescriptor="author|profile-9"
      />,
    );

    press(dismissButton(renderer, 'Person 1'));

    expect(reportedEvents()).toEqual([
      expect.objectContaining({
        feedDescriptor: 'author|profile-9',
        slotKey: 'slot-suggestedUsers',
        kind: 'suggestedUsers',
        event: 'dismiss',
      }),
    ]);
  });

  it('reports nothing for a card rendered outside a feed (no descriptor to attribute to)', async () => {
    const renderer = await renderBand(<FeedInterstitial slot={slot('suggestedUsers')} ordinal={0} />);

    press(dismissButton(renderer, 'Person 1'));

    expect(mockSendInterstitialEvent).not.toHaveBeenCalled();
  });
});

// ── Telemetry ───────────────────────────────────────────────────────────────

/**
 * Longer than the delay after which a mounted, populated band counts as seen
 * (`IMPRESSION_MOUNTED_DELAY_MS`), so the impression has certainly been reported
 * — or certainly has not.
 */
const PAST_IMPRESSION_DELAY_MS = 700;

/** Let the "this card has been seen" delay elapse. */
async function elapseImpressionDelay(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, PAST_IMPRESSION_DELAY_MS);
    });
  });
}

describe('interstitial telemetry', () => {
  it('does not count an impression on mere mount — only once the card has been seen', async () => {
    mockRecommendations = users(5);

    const renderer = await renderBand(<SuggestedUsersInterstitial {...inFeed} ordinal={0} />);
    expect(renderedText(renderer)).toContain(TITLES.suggestedUsers);

    // Mounted and painted, but not yet seen: reporting here would make every
    // card below the fold an impression and the click-through rate meaningless.
    expect(mockSendInterstitialEvent).not.toHaveBeenCalled();

    await elapseImpressionDelay();

    expect(reportedEvents()).toEqual([
      {
        feedDescriptor: FEED_DESCRIPTOR,
        slotKey: SLOT_KEY,
        kind: 'suggestedUsers',
        event: 'impression',
        position: undefined,
      },
    ]);
  });

  it('counts an impression at most ONCE per mounted card', async () => {
    mockRecommendations = users(5);

    const renderer = await renderBand(<SuggestedUsersInterstitial {...inFeed} ordinal={0} />);
    await elapseImpressionDelay();

    // Re-render the band (a dismissal): the card was seen once, not twice.
    press(dismissButton(renderer, 'Person 2'));
    await elapseImpressionDelay();

    const impressions = reportedEvents().filter((event) => event.event === 'impression');
    expect(impressions).toHaveLength(1);
  });

  it('counts no impression for a band the reader never saw — it was unmounted first', async () => {
    mockRecommendations = users(5);

    const renderer = await renderBand(<SuggestedUsersInterstitial {...inFeed} ordinal={0} />);
    act(() => {
      renderer.unmount();
    });

    await elapseImpressionDelay();

    expect(mockSendInterstitialEvent).not.toHaveBeenCalled();
  });

  it('counts no impression while the band is still on placeholders', async () => {
    mockRecommendations = [];
    mockRecommendationsLoading = true;

    const renderer = await renderBand(<SuggestedUsersInterstitial {...inFeed} ordinal={0} />);
    expect(renderedText(renderer)).toContain(TITLES.suggestedUsers);

    await elapseImpressionDelay();

    // The band is standing on skeletons and may yet collapse to nothing: there
    // are no suggestions on screen, so nothing has been seen.
    expect(mockSendInterstitialEvent).not.toHaveBeenCalled();
  });

  it('reports a click on the account the reader tapped, with its position in the card', async () => {
    mockRecommendations = users(5);

    const renderer = await renderBand(<SuggestedUsersInterstitial {...inFeed} ordinal={0} />);

    // The THIRD row: a handler that captured the wrong index would report 0 or 4.
    press(profileRowPressables(renderer)[2]);

    expect(reportedEvents()).toEqual([
      {
        feedDescriptor: FEED_DESCRIPTOR,
        slotKey: SLOT_KEY,
        kind: 'suggestedUsers',
        event: 'click',
        position: 2,
      },
    ]);
  });

  it('reports a follow — and not an unfollow — from the row it happened on', async () => {
    mockRecommendations = users(5);

    const renderer = await renderBand(<SuggestedUsersInterstitial {...inFeed} ordinal={0} />);

    press(followButtons(renderer)[1]);

    expect(reportedEvents()).toEqual([
      expect.objectContaining({ kind: 'suggestedUsers', event: 'follow', position: 1 }),
    ]);
  });

  it('reports a dismissal, and a "see more" with no position (the card, not an item)', async () => {
    mockRecommendations = users(5);

    const renderer = await renderBand(<SuggestedUsersInterstitial {...inFeed} ordinal={0} />);

    press(dismissButton(renderer, 'Person 2'));
    press(seeMoreButtons(renderer)[0]);

    expect(reportedEvents()).toEqual([
      expect.objectContaining({ event: 'dismiss', position: 1 }),
      { feedDescriptor: FEED_DESCRIPTOR, slotKey: SLOT_KEY, kind: 'suggestedUsers', event: 'seeMore', position: undefined },
    ]);
  });

  it('reports a feed subscription — once it actually succeeded — as the feeds card', async () => {
    mockGetMarketplace.mockResolvedValue({ items: feeds(3), total: 3 });

    const renderer = await renderBand(<SuggestedFeedsInterstitial {...inFeed} ordinal={0} />);
    press(subscribeButtons(renderer)[1]);
    await flush();

    expect(reportedEvents()).toEqual([
      expect.objectContaining({ kind: 'suggestedFeeds', event: 'subscribe', position: 1 }),
    ]);
  });

  it('reports nothing when a subscription fails — a failed subscribe is not a subscribe', async () => {
    mockGetMarketplace.mockResolvedValue({ items: feeds(3), total: 3 });
    mockLikeFeed.mockRejectedValue(new Error('nope'));

    const renderer = await renderBand(<SuggestedFeedsInterstitial {...inFeed} ordinal={0} />);
    press(subscribeButtons(renderer)[1]);
    await flush();

    expect(reportedEvents().some((event) => event.event === 'subscribe')).toBe(false);
  });

  it('reports a starter pack as USED when the reader follows all of its members', async () => {
    mockListStarterPacks.mockResolvedValue({ items: packs(3), total: 3 });

    const renderer = await renderBand(<SuggestedStarterPacksInterstitial {...inFeed} ordinal={0} />);
    press(followAllButtons(renderer)[2]);
    await flush();

    expect(reportedEvents()).toEqual([
      expect.objectContaining({ kind: 'suggestedStarterPacks', event: 'use', position: 2 }),
    ]);
  });

  it('reports the similar-accounts card under its own kind', async () => {
    mockGetSimilarProfiles.mockResolvedValue(similarAccounts(5));

    const renderer = await renderBand(
      <SimilarAccountsInterstitial {...inFeed} ordinal={0} subjectId={SUBJECT_ID} />,
    );

    press(followButtons(renderer)[0]);
    press(dismissButton(renderer, 'Similar 2'));

    expect(reportedEvents()).toEqual([
      expect.objectContaining({ kind: 'similarAccounts', event: 'follow', position: 0 }),
      expect.objectContaining({ kind: 'similarAccounts', event: 'dismiss', position: 1 }),
    ]);
  });

  it('never reports a card event through the POST-interaction route', async () => {
    mockRecommendations = users(5);

    const renderer = await renderBand(<SuggestedUsersInterstitial {...inFeed} ordinal={0} />);
    await elapseImpressionDelay();
    press(profileRowPressables(renderer)[0]);
    press(followButtons(renderer)[0]);
    press(dismissButton(renderer, 'Person 2'));
    press(seeMoreButtons(renderer)[0]);

    // `/feed/mtn/interactions` requires a postUri and feeds POST ranking: a card
    // event sent there would credit author/topic affinity with engagement that
    // never touched a post.
    expect(mockSendFeedInteraction).not.toHaveBeenCalled();
    expect(mockSendInterstitialEvent.mock.calls.length).toBeGreaterThan(0);
  });

  it('keeps rendering — and stays interactive — when the telemetry write fails', async () => {
    mockRecommendations = users(5);
    // Both halves of a broken transport: a rejected promise AND a synchronous
    // throw. Neither may reach the reader.
    mockSendInterstitialEvent.mockImplementation(() => {
      throw new Error('telemetry is down');
    });

    const renderer = await renderBand(<SuggestedUsersInterstitial {...inFeed} ordinal={0} />);
    await elapseImpressionDelay();

    expect(renderedText(renderer)).toContain('Person 1');

    // The dismissal still happens: the band's own behavior does not depend on
    // the telemetry write that accompanies it.
    press(dismissButton(renderer, 'Person 2'));

    expect(renderedText(renderer)).not.toContain('Person 2');
    expect(renderedText(renderer)).toContain(TITLES.suggestedUsers);
  });
});
