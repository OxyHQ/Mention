import React from 'react';
import { Text, TouchableOpacity } from 'react-native';
import TestRenderer, { act, type ReactTestInstance } from 'react-test-renderer';
import { QueryClient, QueryClientProvider, notifyManager } from '@tanstack/react-query';
import type { PostUser } from '@mention/shared-types';
import type { CustomFeedDetail } from '@/services/customFeedsService';
import enMessages from '@/locales/en.json';

// `jest.mock` calls are hoisted above these imports, so the screen loads with
// every module boundary below already swapped for its test double.
import CustomFeedTimelineScreen from '@/app/(app)/feeds/[id]';

/**
 * The custom-feed detail screen's Subscribe control.
 *
 * A custom-feed subscription is a `FeedLike` row: `POST|DELETE /feeds/:id/like`
 * moves `CustomFeed.subscriberCount` and sets the viewer's `isLiked`, and that
 * is what the marketplace, the saved-feeds list and this screen read back. The
 * screen used to subscribe through `/entity-follows` instead, writing an
 * `EntityFollow{entityType:'feed'}` row that NOTHING in the codebase ever read —
 * the viewer saw "Subscribed", the count never moved, and the feed never showed
 * up in their subscriptions.
 *
 * These tests drive the real screen and assert at the service boundary, where
 * the two mechanisms are two different modules: the button must reach
 * `customFeedsService` and must NEVER reach `entityFollowService`.
 */

const FEED_ID = 'feed-1';
const VIEWER_ID = 'viewer-1';

// ── Module boundaries ───────────────────────────────────────────────────────

type MessageNode = string | number | boolean | null | MessageNode[] | { [key: string]: MessageNode };

const messages: { [key: string]: MessageNode } = enMessages;

function lookup(key: string): string | undefined {
  const value = key
    .split('.')
    .reduce<MessageNode | undefined>(
      (node, part) =>
        typeof node === 'object' && node !== null && !Array.isArray(node) ? node[part] : undefined,
      messages,
    );
  return typeof value === 'string' ? value : undefined;
}

/**
 * `t` resolves against the REAL `en.json` (including i18next's `_one`/`_other`
 * plural suffixes), so a control wired to a missing key renders its raw key here
 * and fails the assertion instead of shipping "feeds.subscribe" to a user.
 */
function mockTranslate(key: string, vars?: Record<string, string | number>): string {
  const count = typeof vars?.count === 'number' ? vars.count : undefined;
  const candidates =
    count === undefined ? [key] : [`${key}_${count === 1 ? 'one' : 'other'}`, key];
  const template = candidates.map(lookup).find((value) => value !== undefined);
  if (template === undefined) return key;
  if (!vars) return template;
  return template.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => String(vars[name] ?? ''));
}

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: mockTranslate }),
}));

jest.mock('expo-router', () => ({
  router: { push: jest.fn() },
  useLocalSearchParams: () => ({ id: 'feed-1' }),
}));

/** The subscription path under test. */
const mockGetFeed = jest.fn();
const mockLikeFeed = jest.fn();
const mockUnlikeFeed = jest.fn();
const mockGetReviews = jest.fn();
const mockSubmitReview = jest.fn();
jest.mock('@/services/customFeedsService', () => ({
  customFeedsService: {
    get: (...args: unknown[]) => mockGetFeed(...args),
    likeFeed: (...args: unknown[]) => mockLikeFeed(...args),
    unlikeFeed: (...args: unknown[]) => mockUnlikeFeed(...args),
    getReviews: (...args: unknown[]) => mockGetReviews(...args),
    submitReview: (...args: unknown[]) => mockSubmitReview(...args),
  },
}));

/**
 * The DEAD path. `/entity-follows` has no reader for feeds; the screen must not
 * touch this module at all. Mocked so the test can prove it never does.
 */
const mockEntityFollow = jest.fn();
const mockEntityUnfollow = jest.fn();
const mockEntityStatus = jest.fn();
jest.mock('@/services/entityFollowService', () => ({
  entityFollowService: {
    follow: (...args: unknown[]) => mockEntityFollow(...args),
    unfollow: (...args: unknown[]) => mockEntityUnfollow(...args),
    getStatus: (...args: unknown[]) => mockEntityStatus(...args),
  },
}));

const mockToast = jest.fn();
jest.mock('@oxyhq/bloom/toast', () => ({
  show: (...args: unknown[]) => mockToast(...args),
}));

jest.mock('@oxyhq/services', () => {
  const { View: RNView } = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    useAuth: () => ({ user: { id: VIEWER_ID }, isAuthenticated: true }),
    FollowButton: () => <RNView testID="follow-button" />,
  };
});

jest.mock('@oxyhq/core', () => ({
  getNormalizedUserHandle: (user?: { username?: string | null } | null): string | null => {
    const username = (user?.username ?? '').trim().replace(/^@/, '');
    return username.length > 0 ? username : null;
  },
}));

jest.mock('@oxyhq/bloom/theme', () => ({
  useTheme: () => ({
    colors: {
      primary: '#1d4ed8',
      text: '#000000',
      textSecondary: '#666666',
      border: '#dddddd',
      background: '#ffffff',
      backgroundSecondary: '#f2f2f2',
      error: '#dc2626',
    },
  }),
}));

jest.mock('@oxyhq/bloom/loading', () => {
  const { View: RNView } = jest.requireActual<typeof import('react-native')>('react-native');
  return { SpinnerIcon: () => <RNView testID="spinner" /> };
});

jest.mock('@oxyhq/bloom/avatar', () => {
  const { View: RNView } = jest.requireActual<typeof import('react-native')>('react-native');
  return { Avatar: () => <RNView testID="avatar" /> };
});

/** The info sheet is closed until presented, so it contributes no controls. */
jest.mock('@oxyhq/bloom/bottom-sheet', () => ({
  __esModule: true,
  default: () => null,
}));

jest.mock('@/components/Feed/Feed', () => {
  const { View: RNView } = jest.requireActual<typeof import('react-native')>('react-native');
  return { __esModule: true, default: () => <RNView testID="feed" /> };
});

jest.mock('@/components/common/AnimatedTabBar', () => {
  const { View: RNView } = jest.requireActual<typeof import('react-native')>('react-native');
  return { __esModule: true, default: () => <RNView testID="tab-bar" /> };
});

jest.mock('@/components/BottomBarAwareFab', () => {
  const { View: RNView } = jest.requireActual<typeof import('react-native')>('react-native');
  return { BottomBarAwareFab: () => <RNView testID="fab" /> };
});

jest.mock('@/components/ui/Button', () => {
  const { TouchableOpacity: RNTouchable } =
    jest.requireActual<typeof import('react-native')>('react-native');
  return {
    IconButton: ({ children, onPress }: { children?: React.ReactNode; onPress?: () => void }) => (
      <RNTouchable onPress={onPress}>{children}</RNTouchable>
    ),
  };
});

jest.mock('@/assets/icons/back-arrow-icon', () => {
  const { View: RNView } = jest.requireActual<typeof import('react-native')>('react-native');
  return { BackArrowIcon: () => <RNView testID="back-arrow" /> };
});

jest.mock('@/assets/icons/compose-icon', () => {
  const { View: RNView } = jest.requireActual<typeof import('react-native')>('react-native');
  return { ComposeIcon: () => <RNView testID="compose-icon" /> };
});

jest.mock('@/hooks/useSafeBack', () => ({ useSafeBack: () => jest.fn() }));

jest.mock('@/hooks/useFeedPreferences', () => ({
  useFeedPreferences: () => ({ isPinned: () => false, pin: jest.fn(), unpin: jest.fn() }),
}));

jest.mock('@/lib/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

// ── Fixtures ────────────────────────────────────────────────────────────────

const owner: PostUser = {
  id: 'owner-1',
  username: 'curator',
  name: { displayName: 'Curator' },
};

function feedDetail(overrides: Partial<CustomFeedDetail> = {}): CustomFeedDetail {
  return {
    id: FEED_ID,
    ownerOxyUserId: owner.id,
    title: 'Design daily',
    isPublic: true,
    memberOxyUserIds: [],
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
    owner,
    members: [],
    keywords: [],
    isLiked: false,
    likeCount: 7,
    ...overrides,
  };
}

// ── Harness ─────────────────────────────────────────────────────────────────

/**
 * React Query batches its subscriber notifications on a timer by default, which
 * lands renders outside `act`. Notify synchronously so a settled query/mutation
 * is on screen the moment the awaited work resolves.
 */
notifyManager.setScheduler((callback) => callback());

/** Let queued promises AND timers settle inside `act`. */
async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function renderScreen(): Promise<TestRenderer.ReactTestRenderer> {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });

  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <QueryClientProvider client={queryClient}>
        <CustomFeedTimelineScreen />
      </QueryClientProvider>,
    );
  });
  await flush();
  return renderer;
}

/**
 * The subscribe pill: the one control on the screen that reports a selected
 * (subscribed) state. Throws if it is missing — a screen that lost its Subscribe
 * button is exactly the regression this file guards.
 */
function subscribePill(root: ReactTestInstance): ReactTestInstance {
  return root.find(
    (node) =>
      node.type === TouchableOpacity &&
      node.props.accessibilityRole === 'button' &&
      typeof node.props.accessibilityState?.selected === 'boolean',
  );
}

function labelOf(pill: ReactTestInstance): string {
  return pill
    .findAllByType(Text)
    .map((node) => node.props.children)
    .filter((child): child is string => typeof child === 'string')
    .join('');
}

function renderedTexts(root: ReactTestInstance): string[] {
  return root
    .findAllByType(Text)
    .map((node) => node.props.children)
    .filter((child): child is string => typeof child === 'string');
}

async function press(pill: ReactTestInstance): Promise<void> {
  await act(async () => {
    pill.props.onPress();
  });
  await flush();
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('custom feed detail — subscribe', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetReviews.mockResolvedValue({ reviews: [], total: 0, page: 1, totalPages: 1 });
  });

  it('subscribes through the FeedLike path and never through entity-follows', async () => {
    mockGetFeed.mockResolvedValue(feedDetail({ isLiked: false, likeCount: 7 }));
    mockLikeFeed.mockResolvedValue({ success: true, liked: true, likeCount: 8 });

    const renderer = await renderScreen();
    const root = renderer.root;

    expect(labelOf(subscribePill(root))).toBe('Subscribe');
    expect(renderedTexts(root)).toContain('7');

    await press(subscribePill(root));

    // The ONE subscription endpoint: it writes the FeedLike row and moves
    // CustomFeed.subscriberCount.
    expect(mockLikeFeed).toHaveBeenCalledTimes(1);
    expect(mockLikeFeed).toHaveBeenCalledWith(FEED_ID);

    // The dead mechanism must be untouched: no `EntityFollow{entityType:'feed'}`
    // row is written, and the screen does not even ask for its status.
    expect(mockEntityFollow).not.toHaveBeenCalled();
    expect(mockEntityStatus).not.toHaveBeenCalled();

    // The subscribed state — and the count — come back from that same record.
    const pill = subscribePill(root);
    expect(labelOf(pill)).toBe('Subscribed');
    expect(pill.props.accessibilityState.selected).toBe(true);
    expect(renderedTexts(root)).toContain('8');
    expect(mockToast).not.toHaveBeenCalled();
  });

  it('renders the subscribed state a subscriber already has, and unsubscribes', async () => {
    mockGetFeed.mockResolvedValue(feedDetail({ isLiked: true, likeCount: 12 }));
    mockUnlikeFeed.mockResolvedValue({ success: true, liked: false, likeCount: 11 });

    const renderer = await renderScreen();
    const root = renderer.root;

    // The pill reads its state from `isLiked` — the same flag every other feed
    // surface reads — so a viewer who subscribed elsewhere sees it here.
    expect(labelOf(subscribePill(root))).toBe('Subscribed');

    await press(subscribePill(root));

    expect(mockUnlikeFeed).toHaveBeenCalledWith(FEED_ID);
    expect(mockEntityUnfollow).not.toHaveBeenCalled();
    expect(labelOf(subscribePill(root))).toBe('Subscribe');
    expect(renderedTexts(root)).toContain('11');
  });

  it('rolls the optimistic subscribe back when the request fails', async () => {
    mockGetFeed.mockResolvedValue(feedDetail({ isLiked: false, likeCount: 7 }));
    mockLikeFeed.mockRejectedValue(new Error('network down'));

    const renderer = await renderScreen();
    const root = renderer.root;

    await press(subscribePill(root));

    const pill = subscribePill(root);
    expect(labelOf(pill)).toBe('Subscribe');
    expect(pill.props.accessibilityState.selected).toBe(false);
    expect(renderedTexts(root)).toContain('7');
    expect(mockToast).toHaveBeenCalledWith("Couldn't update your subscription", { type: 'error' });
  });
});
