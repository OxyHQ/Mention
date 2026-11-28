import type { ReactElement, ReactNode } from 'react';
import { createElement, isValidElement } from 'react';
import { StyleSheet, View } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import { BloomProvider } from '@oxy.so/bloom/provider';
import { toElement } from '@oxy.so/bloom-language';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

import { toBloomCatalog } from '@/lib/bloomCatalog';
import { preferBloomLocale, registerBloomCatalog } from '@/lib/bloomLocalization.bloom';
import { appI18n, initializeI18n } from '@/lib/i18n';
import en from '@/locales/en.json';

/**
 * DEV ONLY. The corpus render check for the files lang-mention-13 found with no Mention test
 * (Bloom PR #1007's handoff): each file drawn in both forms with the same props and stand-ins,
 * under Mention's Bloom provider, i18n and React Query, after its async work settles. A file
 * passes when its `.bloom` form (`./bloom/`, `bloom migrate --print` with `@/` imports) draws
 * the same host tree as the TypeScript it came from.
 *
 * Run with `bun run test:perf __perf__/lang-proof/corpus13`.
 */

const mockPushes: string[] = [];

/** JSON of a stub's props: elements are drawn as its children, functions are left out. */
function mockHint(props: Record<string, unknown>): string {
  return JSON.stringify(props, (_k, v) =>
    typeof v === 'object' && v && '$$typeof' in v ? '[react]' : v,
  );
}

/**
 * A stand-in for a child component the file draws: a host view carrying its props, with each
 * prop that is a React element drawn inside it (a slot), so what the file hands it is compared.
 */
function mockStub(name: string, nodeProps: readonly string[] = []) {
  const { createElement: h, isValidElement: valid } =
    jest.requireActual<typeof import('react')>('react');
  const { View: V } = jest.requireActual<typeof import('react-native')>('react-native');
  // biome-ignore lint/correctness/noComponentHookFactories: one stub per mocked module, made once when jest.mock runs
  return function Stub(props: Record<string, unknown>) {
    const { children, ...rest } = props;
    // A `ReactNode` prop the component draws in its own `Text` (`nodeProps`) is a slot whether
    // it is an element or a string: the component draws both the same.
    const slot = (k: string, v: unknown) =>
      valid(v) || (nodeProps.includes(k) && typeof v === 'string');
    const slots = Object.entries(rest)
      .filter(([k, v]) => slot(k, v))
      .map(([k, v]) => h(V, { key: k, testID: `slot:${name}.${k}` }, v as ReactNode));
    const hinted = Object.fromEntries(
      Object.entries(rest)
        // …and `null` is `undefined` there: both draw nothing.
        .filter(([k, v]) => !(nodeProps.includes(k) && v == null))
        .map(([k, v]) => [k, slot(k, v) ? '[node]' : v]),
    );
    return h(
      V,
      { testID: `stub:${name}`, accessibilityHint: mockHint(hinted) },
      ...slots,
      children as ReactNode,
    );
  };
}

/** A stand-in for a `.bloom` view: called as a view, drawn as the stub component's node. */
function mockView(name: string) {
  return (props: Record<string, unknown>) =>
    jest
      .requireActual<typeof import('@oxy.so/bloom-language')>('@oxy.so/bloom-language')
      .Embed(
        jest.requireActual<typeof import('react')>('react').createElement(mockStub(name), props),
      );
}

const mockRouter = {
  push: (href: unknown) => mockPushes.push(JSON.stringify(href)),
  back: () => mockPushes.push('<back>'),
  replace: (href: unknown) => mockPushes.push(JSON.stringify(href)),
  canGoBack: () => false,
  navigate: (href: unknown) => mockPushes.push(JSON.stringify(href)),
  setParams: () => undefined,
  dismiss: () => undefined,
};

jest.mock('@/lib/navigation/router', () => ({
  Link: ({ children }: { children: ReactNode }) => children,
  useRouter: () => mockRouter,
  useLocalSearchParams: () => mockWorld.params,
  useFocusEffect: (effect: () => void) => {
    const { useEffect } = jest.requireActual<typeof import('react')>('react');
    useEffect(() => effect(), [effect]);
  },
}));
jest.mock('expo-router', () => ({
  Link: ({ children }: { children: ReactNode }) => children,
  useRouter: () => mockRouter,
  router: { push: (href: unknown) => mockRouter.push(href), back: () => mockRouter.back() },
  useLocalSearchParams: () => mockWorld.params,
  useGlobalSearchParams: () => mockWorld.params,
  usePathname: () => '/',
  useSegments: () => [],
  useNavigation: () => ({ addListener: () => () => undefined, setOptions: () => undefined }),
  useFocusEffect: (effect: () => void) => {
    const { useEffect } = jest.requireActual<typeof import('react')>('react');
    useEffect(() => effect(), [effect]);
  },
}));
jest.mock('@oxy.so/services/ui/client', () => ({ useAuth: () => mockWorld.auth }));
jest.mock('@oxy.so/bloom/toast', () => ({ toast: () => undefined }));
jest.mock('@/components/Feed/PostItem.bloom', () => ({ PostItem: mockView('PostItem') }));
jest.mock('@/components/Post/postEngagementContext', () => ({
  useOpenPostEngagement: () => mockOpenPostEngagement,
}));
jest.mock('@oxy.so/bloom/chart-cards', () => ({
  BarListCard: mockStub('BarListCard'),
  ChartCardSurface: mockStub('ChartCardSurface'),
  SleepScoreCard: mockStub('SleepScoreCard'),
  ChartStatTiles: mockStub('ChartStatTiles'),
  StepsCard: mockStub('StepsCard'),
  StageBarsCard: mockStub('StageBarsCard'),
  ContributionsCard: mockStub('ContributionsCard'),
}));
jest.mock('@/components/Profile/useProfileMediaFeed', () => ({
  useProfileMediaFeed: () => mockWorld.mediaFeed,
}));
jest.mock('@/components/Profile/ProfileGridList', () => {
  const { createElement: h } = jest.requireActual<typeof import('react')>('react');
  const { View: V } = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    // The grid's cells, each drawn by the file's own `renderCell` at one size.
    ProfileGridList: (props: Record<string, unknown>) => {
      const { data, renderCell, emptyComponent, ...rest } = props as {
        data: unknown[];
        renderCell: (item: unknown, size: number) => ReactNode;
        emptyComponent?: ReactNode;
      } & Record<string, unknown>;
      return h(
        V,
        { testID: 'stub:ProfileGridList', accessibilityHint: mockHint(rest) },
        h(V, { testID: 'slot:empty' }, emptyComponent ?? null),
        ...data.map((item, i) => h(V, { key: i, testID: `cell:${i}` }, renderCell(item, 120))),
      );
    },
  };
});
jest.mock('@/components/Profile/LiveVideoPosterCell', () => ({
  __esModule: true,
  default: mockStub('LiveVideoPosterCell'),
}));
jest.mock('@/components/common/EmptyState', () => ({ EmptyState: mockStub('EmptyState') }));
jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: async () => mockWorld.recentEmojis,
    setItem: async () => undefined,
  },
}));
jest.mock('@/hooks/useInfiniteCatalogSearch', () => ({
  useInfiniteCatalogSearch: () => mockWorld.search,
  ResultsFooter: mockStub('ResultsFooter'),
}));
jest.mock('@/components/SupervisedFeatureGate', () => ({
  SupervisedFeatureGate: ({ children }: { children: ReactNode }) => children,
}));
jest.mock('@/components/SEO', () => ({ SEO: mockStub('SEO') }));
jest.mock('@/hooks/useFeedPreferences', () => ({
  useFeedPreferences: () => mockWorld.feedPreferences,
}));
jest.mock('@/hooks/useAgeProtections', () => ({
  useAgeProtections: () => ({ feedProfile: mockWorld.feedProfile }),
}));
jest.mock('@/stores/trendsStore', () => ({
  useTrendsStore: (select: (state: unknown) => unknown) => select(mockWorld.trendsState),
}));
jest.mock('@/services/customFeedsService', () => ({
  customFeedsService: {
    list: async (options: { mine?: boolean }) =>
      options.mine
        ? { items: mockWorld.myFeeds, total: 0 }
        : { items: mockWorld.publicFeeds, total: 0 },
  },
}));
jest.mock('@/utils/feedTelemetry', () => ({ reportTrendEvent: () => undefined }));
jest.mock('@/services/jobsService', () => ({
  jobsService: { get: async () => mockWorld.job() },
  recordJobMetric: () => undefined,
}));
jest.mock('@/services/reportService', () => ({ reportService: { reportJob: async () => true } }));
jest.mock('@/utils/sheet', () => ({ presentSheet: async () => undefined }));
jest.mock('@/utils/shareLink', () => ({ shareLink: async () => undefined }));
jest.mock('@/utils/openExternalLink', () => ({ openExternalLink: async () => undefined }));
jest.mock('@/services/pokeService', () => ({
  pokeService: {
    getReceivedPokes: async () => mockWorld.pokes.received(),
    getSentPokes: async () => ({ pokes: mockWorld.pokes.sent }),
    getSuggested: async () => ({ suggestions: mockWorld.pokes.suggested }),
    poke: async () => undefined,
    unpoke: async () => undefined,
  },
}));
// `meta` is drawn as `LText(Embed(meta))`: a string and a fragment of strings are the same text.
jest.mock('@/components/ProfileCard', () => ({ ProfileCard: mockStub('ProfileCard', ['meta']) }));
jest.mock('@/components/suggestions/SuggestedUsers', () => ({
  SuggestedUsers: mockStub('SuggestedUsers'),
}));
jest.mock('@/components/Error', () => ({ Error: mockStub('Error') }));
jest.mock('@/components/suggestions/SuggestedUserCard', () => ({
  SuggestedUserCard: mockStub('SuggestedUserCard'),
}));
jest.mock('@/hooks/useRecommendations', () => ({
  useRecommendations: () => ({ recommendations: mockWorld.recommendations }),
}));
jest.mock('@/lib/actorCache', () => ({ actorWriter: () => ({ cacheActors: () => undefined }) }));
jest.mock('@/utils/userEnrichment', () => ({ enrichMissingAvatars: async () => undefined }));
// PostDetailScreen's stand-ins: its children, data and services.
jest.mock('@/components/Post/CompactReplyComposer', () => ({
  CompactReplyComposer: mockStub('CompactReplyComposer'),
}));
jest.mock('@/components/Post/PostReplyFooter', () => ({
  PostReplyFooter: mockStub('PostReplyFooter'),
}));
jest.mock('@/components/Post/PostReplyNavigationContext', () => ({
  usePostOwnsNavigation: () => false,
}));
jest.mock('@/components/Feed/Feed', () => ({ __esModule: true, default: mockStub('Feed') }));
jest.mock('@/components/ReplyPreferencesSheet', () => ({
  __esModule: true,
  default: mockStub('ReplyPreferencesSheet'),
}));
jest.mock('@/components/loading/ContentSkeleton', () => ({
  ...jest.requireActual('@/components/loading/ContentSkeleton'),
  FeedSkeleton: mockStub('FeedSkeleton'),
}));
jest.mock('@/data/feeds', () => ({ prefetchFeed: () => undefined }));
jest.mock('@/data/posts', () => ({ Post: { load: async () => undefined } }));
jest.mock('@/hooks/useAfterFirstFrame', () => ({ useAfterFirstFrame: () => true }));
jest.mock('@/hooks/usePostReadAccess', () => ({ usePostReadAccess: () => mockWorld.postAccess }));
jest.mock('@/hooks/useThreadPreferences', () => {
  const prefs = { sortOrder: 'top', treeView: false, loaded: true };
  return {
    SORT_TO_API: { top: 'top', latest: 'latest' },
    useThreadPreferences: () => prefs,
    useThreadPreferencesStore: (pick: (s: typeof prefs) => unknown) => pick(prefs),
  };
});
jest.mock('@/lib/seoHandoff', () => ({ readServerSEO: () => undefined }));
jest.mock('@/modules/mention-widgets', () => ({ getFollowingCachedPost: async () => null }));
jest.mock('@/services/commerceService', () => ({
  commerceService: { recordMetric: async () => undefined },
}));
jest.mock('@/services/feedService', () => ({
  feedService: { getThreadContinuations: async () => mockWorld.detail.continuations },
}));
jest.mock('@/services/insightsService', () => ({
  insightsService: { trackPostView: async () => ({ viewsCount: 1 }) },
}));
jest.mock('@/services/socketService', () => ({
  socketService: { joinPost: () => undefined, leavePost: () => undefined },
}));
jest.mock('@/stores/postsStore', () => {
  const state = () => ({
    getPostById: async () => mockWorld.detail.fetched,
    revalidatePostById: async () => mockWorld.detail.cached,
    getPostFromDb: () => mockWorld.detail.cached ?? undefined,
    loadPostAncestors: async () => mockWorld.detail.ancestors,
    cachePosts: () => undefined,
  });
  const usePostsStore = (pick: (s: ReturnType<typeof state>) => unknown) => pick(state());
  usePostsStore.getState = state;
  return {
    applyServerViewCounts: () => undefined,
    getCachedAncestorChain: () => mockWorld.detail.ancestors,
    usePostsStore,
    usePostSelector: () => mockWorld.detail.cached,
  };
});
jest.mock('@/hooks/useSupervisionState', () => ({
  useSupervisionState: () => ({ isSupervised: false, restrictions: {} }),
}));

const mockOpenPostEngagement = () => undefined;

const pokeUser = (id: string) => ({
  id,
  username: `user${id}`,
  name: { displayName: `User ${id}` },
  avatar: undefined,
});
const DAY = 24 * 60 * 60 * 1000;
const longAgo = new Date(Date.now() - 3 * DAY).toISOString();

/** The world the stand-ins read; each state sets the part it needs before drawing. */
const mockWorld = {
  params: {} as Record<string, string>,
  auth: {} as Record<string, unknown>,
  mediaFeed: {} as Record<string, unknown>,
  recentEmojis: null as string | null,
  search: {} as Record<string, unknown>,
  feedPreferences: {} as Record<string, unknown>,
  feedProfile: 'standard' as string,
  trendsState: {} as Record<string, unknown>,
  myFeeds: [] as unknown[],
  publicFeeds: [] as unknown[],
  job: (() => ({ job: null })) as () => unknown,
  recommendations: [] as unknown[],
  similar: [] as unknown[],
  pokes: {
    received: (() => ({ pokes: [] })) as () => unknown,
    sent: [] as unknown[],
    suggested: [] as unknown[],
  },
  postAccess: {} as Record<string, unknown>,
  detail: {
    cached: null as unknown,
    fetched: null as unknown,
    ancestors: [] as unknown[],
    continuations: [] as unknown[],
  },
};

const detailPost = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  user: { id: 'u1', username: 'user1', name: { displayName: 'User 1' } },
  content: { text: `Post ${id}` },
  metadata: { createdAt: longAgo, updatedAt: longAgo, visibility: 'public' },
  visibility: 'public',
  status: 'published',
  ...extra,
});
const allowed = { allowed: true, failed: false, supervised: false, retry: () => undefined };

const signedIn = () => ({
  user: { id: 'me', username: 'me' },
  isAuthenticated: true,
  isAuthResolved: true,
  canUsePrivateApi: true,
  isPrivateApiPending: false,
  oxyServices: {
    users: {
      get: async (id: string) => ({ id, username: `emp${id}`, name: { displayName: 'Acme Corp' } }),
      similar: async () => mockWorld.similar,
      getMany: async () => [],
    },
    assets: { renderUrl: (id: string, variant: string) => `https://cdn.test/${id}?v=${variant}` },
  },
});

const stats = {
  period: { startDate: '2026-11-16T00:00:00.000Z', endDate: '2026-11-22T00:00:00.000Z', days: 7 },
  overview: {
    totalPosts: 9,
    totalViews: 1234,
    totalInteractions: 87,
    engagementRate: 7.05,
    averageEngagementPerPost: 9.67,
  },
  interactions: { likes: 50, replies: 20, boosts: 12, shares: 5 },
  dailyBreakdown: [
    { date: '2026-11-16', views: 100, likes: 4, replies: 1, boosts: 0, interactions: 5 },
    { date: '2026-11-17', views: 300, likes: 10, replies: 5, boosts: 2, interactions: 17 },
    { date: '2026-11-18', views: 0, likes: 0, replies: 0, boosts: 0, interactions: 0 },
    { date: '2026-11-19', views: 434, likes: 20, replies: 8, boosts: 6, interactions: 34 },
    { date: '2026-11-20', views: 200, likes: 8, replies: 3, boosts: 2, interactions: 13 },
    { date: '2026-11-21', views: 0, likes: 0, replies: 0, boosts: 0, interactions: 0 },
    { date: '2026-11-22', views: 200, likes: 8, replies: 3, boosts: 2, interactions: 18 },
  ],
  topPosts: [
    {
      postId: 'p1',
      views: 400,
      likes: 20,
      replies: 8,
      boosts: 6,
      engagement: 34,
      createdAt: '2026-11-19T10:00:00.000Z',
    },
  ],
  postsByType: { text: 5, image: 3, video: 1, poll: 0 },
};
const emptyStats = {
  ...stats,
  overview: {
    totalPosts: 0,
    totalViews: 0,
    totalInteractions: 0,
    engagementRate: 0,
    averageEngagementPerPost: 0,
  },
  interactions: { likes: 0, replies: 0, boosts: 0, shares: 0 },
  dailyBreakdown: [],
  topPosts: [],
  postsByType: {},
};

const mediaPost = (id: string, media: unknown[], extra: Record<string, unknown> = {}) => ({
  id,
  content: { text: `post ${id}`, media },
  engagement: { views: 42 },
  ...extra,
});
const feedState = (items: unknown[], isLoading = false) => ({
  primaryFeed: { items, isLoading, hasMore: false },
  postsFeed: { items: [], isLoading: false, hasMore: false },
  items,
  loadMore: () => undefined,
  restorationKey: 'k',
});
const mediaItems = [
  mediaPost('m1', [
    {
      id: 'img1',
      type: 'image',
      url: 'https://cdn.test/1.jpg',
      thumbUrl: 'https://cdn.test/1t.jpg',
    },
  ]),
  mediaPost('m2', [
    {
      id: 'vid1',
      type: 'video',
      url: 'https://cdn.test/v.mp4',
      posterUrl: 'https://cdn.test/vp.jpg',
      duration: 12,
    },
    { id: 'img2', type: 'image', url: 'https://cdn.test/2.jpg' },
  ]),
  mediaPost('m3', [], {
    quotedPost: mediaPost('q1', [{ id: 'img3', type: 'image', url: 'https://cdn.test/3.jpg' }]),
  }),
  mediaPost('m4', [{ id: 'vid2', type: 'video', url: 'oxyfile123', duration: 61 }]),
];

const searchState = (over: Record<string, unknown>) => ({
  results: [],
  hasQuery: false,
  isLoading: false,
  isError: false,
  isFetchingNextPage: false,
  loadMore: () => undefined,
  ...over,
});

const feedPrefs = (canEdit: boolean) => ({
  isPinned: (key: string) => key === 'for_you' || key === 'custom:f2',
  pin: () => undefined,
  unpin: () => undefined,
  canEdit,
});
const trends = (list: unknown[]) => ({
  trends: list,
  hiddenTrendIds: ['t3'],
  fetchTrends: async () => undefined,
  hasFetched: true,
});
const customFeed = (id: string, over: Record<string, unknown> = {}) => ({
  _id: id,
  title: `Feed ${id}`,
  description: id === 'f1' ? 'All about cats' : undefined,
  owner: { username: `owner${id}` },
  memberOxyUserIds: id === 'f1' ? ['a', 'b', 'c'] : [],
  likeCount: id === 'f2' ? 1500 : 0,
  ...over,
});

const job = (over: Record<string, unknown> = {}) => ({
  job: {
    id: 'j1',
    title: 'Senior Gardener',
    status: 'published',
    employerOxyUserId: 'e1',
    canonicalUrl: 'https://mention.test/jobs/j1',
    description: 'Tend the gardens.',
    location: { city: 'Barcelona', country: 'ES' },
    workplaceType: 'hybrid',
    employmentType: 'full_time',
    salary: { min: 30000, max: 45000, currency: 'EUR', interval: 'year' },
    skills: ['Pruning', 'Botany'],
    applicationMode: 'external',
    externalApplyUrl: 'https://apply.test',
    ...over,
  },
});

type Props = Record<string, unknown>;
type Module = Record<string, unknown>;

interface Case {
  file: string;
  /** The TypeScript form's export. */
  name: string;
  /** The `.bloom` form's export, when it is not `name`. */
  bloomExport?: string;
  /** The `.bloom` export is a component (a `Screen`), drawn as `<X />`, not called as a view. */
  bloomComponent?: boolean;
  /** Both forms are functions of one value (`postLocation(location)`), called and drawn. */
  call?: boolean;
  ts: () => Module;
  bloom: () => Module;
  states: Record<
    string,
    {
      props: Props;
      before: () => void;
      interact?: (r: TestRenderer.ReactTestRenderer) => void;
      /** The file draws nothing in this state (both forms must agree on that). */
      empty?: boolean;
    }
  >;
}

/**
 * The states whose `.bloom` form draws differently today, each with the Bloom repro that explains
 * it (`~/.local/share/bloom-lang/repros/mention13/<name>`, Bloom PR #1007's Handoff). They run as
 * `it.failing`, so a fix shows up here as a failure to remove; `PROOF_BROKEN=1` runs them as tests.
 */
const BROKEN: Record<string, string> = {
  ...Object.fromEntries(
    ['accessFailed', 'gated', 'notFound', 'fetched', 'reply'].map((state) => [
      `components/Post/PostDetailScreen.tsx/${state}`,
      "refused until Task.cancellation (mention15 task-defer-runs-at-once: the load's `cancelled = true`); the chrome from the drawn branch (core12)",
    ]),
  ),
  'components/Compose/PodcastPickerSheet.tsx/results': 'closure-view-to-reactelement (renderItem)',
  'components/payments/MerchantInstallmentSettings.tsx/closed': 'record-update-arrow-body',
  'components/payments/MerchantInstallmentSettings.tsx/open': 'record-update-arrow-body',
  'components/payments/MerchantInstallmentSettings.tsx/openDisabled': 'record-update-arrow-body',
  'app/(app)/feeds.tsx/signedOut': 'the codemod: a screen() inside the route wrapper (refused now)',
  'app/(app)/feeds.tsx/populated':
    'the codemod: a screen() inside the route wrapper; foreign-enumerated',
  'app/(app)/feeds.tsx/protectedMinor':
    'the codemod: a screen() inside the route wrapper (refused now)',
  'app/(app)/jobs/[id].tsx/notFound': "screen-group-root: each branch's .header under a Group root",
  'app/(app)/jobs/[id].tsx/published':
    "screen-group-root: each branch's .header under a Group root",
  'app/(app)/jobs/[id].tsx/draftOnMention':
    "screen-group-root: each branch's .header under a Group root",
};

const noop = () => undefined;

/** Presses the first button the screen draws (a Bloom `Button`: its pressable's `onPress`). */
function pressFirstButton(r: TestRenderer.ReactTestRenderer) {
  const host = r.root.findAll(
    (n) => typeof n.type === 'string' && n.props.accessibilityRole === 'button',
  )[0];
  let at: TestRenderer.ReactTestInstance | null = host ?? null;
  while (at && typeof at.props.onPress !== 'function') at = at.parent;
  if (!at) throw new Error('no button to press');
  at.props.onPress({ nativeEvent: {}, preventDefault: noop, stopPropagation: noop });
}

const suggested = (id: string) => ({ id, username: `u${id}`, name: { displayName: `User ${id}` } });
const installments = {
  enabled: true,
  families: ['pay_in_4', 'pay_later'],
  minMinorUnits: 5000,
  maxMinorUnits: 100000,
  countries: ['ES'],
  currencies: ['EUR'],
  purchaseKinds: ['one_time'],
  message: 'Split it in four.',
  terms: '',
};

const CASES: Case[] = [
  {
    file: 'components/suggestions/SuggestedUsers.tsx',
    name: 'SuggestedUsers',
    ts: () => jest.requireActual('@/components/suggestions/SuggestedUsers'),
    bloom: () => require('./bloom/SuggestedUsers.bloom'),
    states: {
      recommended: {
        props: { maxCards: 2 },
        before: () => {
          mockWorld.auth = signedIn();
          mockWorld.recommendations = [suggested('1'), suggested('2'), suggested('3')];
        },
      },
      similar: {
        props: { sourceUserId: '2', title: 'Similar', hideDismiss: true },
        before: () => {
          mockWorld.auth = signedIn();
          mockWorld.recommendations = [];
          mockWorld.similar = [suggested('2'), suggested('4')];
        },
      },
      hidden: {
        props: { visible: false },
        empty: true,
        before: () => {
          mockWorld.auth = signedIn();
          mockWorld.recommendations = [suggested('1')];
        },
      },
      none: {
        props: {},
        empty: true,
        before: () => {
          mockWorld.auth = signedIn();
          mockWorld.recommendations = [];
        },
      },
    },
  },
  {
    file: 'components/payments/MerchantInstallmentSettings.tsx',
    name: 'MerchantInstallmentSettings',
    ts: () => require('@/components/payments/MerchantInstallmentSettings'),
    bloom: () => require('./bloom/MerchantInstallmentSettings.bloom'),
    states: {
      closed: { props: { value: installments, onChange: noop }, before: noop },
      open: {
        props: { value: installments, onChange: noop },
        before: noop,
        interact: pressFirstButton,
      },
      openDisabled: {
        props: { value: { ...installments, enabled: false, families: [] }, onChange: noop },
        before: noop,
        interact: pressFirstButton,
      },
    },
  },
  {
    file: 'components/Post/PostLocation.tsx',
    name: 'postLocation',
    call: true,
    ts: () => require('./ts/PostLocation'),
    bloom: () => require('@/components/Post/PostLocation.bloom'),
    states: {
      address: {
        props: { type: 'Point', coordinates: [2.1734, 41.3851], address: 'Barcelona' },
        before: noop,
      },
      coordinates: { props: { type: 'Point', coordinates: [2.1734, 41.3851] }, before: noop },
    },
  },
  {
    file: 'components/insights/WeeklyRecapContent.tsx',
    name: 'WeeklyRecapContent',
    ts: () => require('@/components/insights/WeeklyRecapContent'),
    bloom: () => require('./bloom/WeeklyRecapContent.bloom'),
    states: {
      populated: {
        props: {
          stats,
          summary: 'A strong week for images.',
          topPosts: [
            { id: 'p1', content: { text: 'top' } },
            { id: 'p2', content: { text: 'second' } },
          ],
        },
        before: noop,
      },
      empty: { props: { stats: emptyStats, summary: null, topPosts: [] }, before: noop },
      unloadedPosts: { props: { stats, summary: null, topPosts: [] }, before: noop },
    },
  },
  {
    file: 'components/Profile/MediaGrid.tsx',
    name: 'default',
    bloomExport: 'MediaGrid',
    ts: () => require('@/components/Profile/MediaGrid'),
    bloom: () => require('./bloom/MediaGrid.bloom'),
    states: {
      loading: {
        props: { userId: 'u1' },
        before: () => {
          mockWorld.mediaFeed = feedState([], true);
        },
      },
      empty: {
        props: { userId: 'u1' },
        before: () => {
          mockWorld.mediaFeed = feedState([]);
        },
      },
      emptyOwnsScroll: {
        props: { userId: 'u1', ownsScroll: true },
        before: () => {
          mockWorld.mediaFeed = feedState([]);
        },
      },
      cells: {
        props: { userId: 'u1', ownsScroll: true },
        before: () => {
          mockWorld.mediaFeed = feedState(mediaItems);
        },
      },
    },
  },
  {
    file: 'components/Profile/VideosGrid.tsx',
    name: 'default',
    bloomExport: 'VideosGrid',
    ts: () => require('@/components/Profile/VideosGrid'),
    bloom: () => require('./bloom/VideosGrid.bloom'),
    states: {
      loading: {
        props: { userId: 'u1' },
        before: () => {
          mockWorld.auth = signedIn();
          mockWorld.mediaFeed = feedState([], true);
        },
      },
      empty: {
        props: { userId: 'u1' },
        before: () => {
          mockWorld.auth = signedIn();
          mockWorld.mediaFeed = feedState([]);
        },
      },
      cells: {
        props: { userId: 'u1', ownsScroll: true },
        before: () => {
          mockWorld.auth = signedIn();
          mockWorld.mediaFeed = feedState(mediaItems);
        },
      },
    },
  },
  {
    file: 'components/Compose/EmojiPickerSheet.tsx',
    name: 'default',
    bloomExport: 'EmojiPickerSheet',
    ts: () => require('@/components/Compose/EmojiPickerSheet'),
    bloom: () => require('./bloom/EmojiPickerSheet.bloom'),
    states: {
      noRecent: {
        props: { onClose: noop, onSelectEmoji: noop },
        before: () => {
          mockWorld.recentEmojis = null;
        },
      },
      recent: {
        props: { onClose: noop, onSelectEmoji: noop },
        before: () => {
          mockWorld.recentEmojis = JSON.stringify(['😀', '🎉', '🐱']);
        },
      },
    },
  },
  {
    file: 'components/Compose/PodcastPickerSheet.tsx',
    name: 'default',
    bloomExport: 'PodcastPickerSheet',
    ts: () => require('@/components/Compose/PodcastPickerSheet'),
    bloom: () => require('./bloom/PodcastPickerSheet.bloom'),
    states: {
      hint: {
        props: { onSelect: noop, onClose: noop },
        before: () => {
          mockWorld.search = searchState({});
        },
      },
      loading: {
        props: { onSelect: noop, onClose: noop },
        before: () => {
          mockWorld.search = searchState({ isLoading: true, hasQuery: true });
        },
      },
      error: {
        props: { onSelect: noop, onClose: noop },
        before: () => {
          mockWorld.search = searchState({ isError: true, hasQuery: true });
        },
      },
      empty: {
        props: { onSelect: noop, onClose: noop },
        before: () => {
          mockWorld.search = searchState({ hasQuery: true });
        },
      },
      results: {
        props: { onSelect: noop, onClose: noop },
        before: () => {
          mockWorld.search = searchState({
            hasQuery: true,
            isFetchingNextPage: true,
            results: [
              {
                syraPodcastId: 's1',
                title: 'Garden Talk',
                author: 'Ana',
                artworkUrl: 'https://cdn.test/a.jpg',
              },
              { syraPodcastId: 's2', title: 'No Art Show' },
            ],
          });
        },
      },
    },
  },
  {
    file: 'app/(app)/feeds.tsx',
    name: 'default',
    bloomExport: 'AvailableFeedsScreen',
    bloomComponent: true,
    ts: () => require('@/app/(app)/feeds'),
    bloom: () => require('./bloom/Feeds.bloom'),
    states: {
      signedOut: {
        props: {},
        before: () => {
          mockWorld.auth = {
            isAuthResolved: true,
            canUsePrivateApi: false,
            isPrivateApiPending: false,
          };
          mockWorld.feedPreferences = feedPrefs(false);
          mockWorld.feedProfile = 'standard';
          mockWorld.trendsState = trends([]);
          mockWorld.myFeeds = [];
          mockWorld.publicFeeds = [];
        },
      },
      populated: {
        props: {},
        before: () => {
          mockWorld.auth = signedIn();
          mockWorld.feedPreferences = feedPrefs(true);
          mockWorld.feedProfile = 'standard';
          mockWorld.trendsState = trends([
            { id: 't1', text: 'cats', displayName: '#cats', type: 'hashtag', authorCount: 12 },
            { id: 't2', text: 'dogs', displayName: '#dogs', type: 'hashtag' },
            { id: 't3', text: 'hidden', displayName: '#hidden', type: 'hashtag' },
          ]);
          mockWorld.myFeeds = [customFeed('f2')];
          mockWorld.publicFeeds = [
            customFeed('f1'),
            customFeed('f2'),
            customFeed('f3', { title: undefined }),
          ];
        },
      },
      protectedMinor: {
        props: {},
        before: () => {
          mockWorld.auth = signedIn();
          mockWorld.feedPreferences = feedPrefs(false);
          mockWorld.feedProfile = 'protected';
          mockWorld.trendsState = trends([]);
          mockWorld.myFeeds = [];
          mockWorld.publicFeeds = [customFeed('f1')];
        },
      },
    },
  },
  {
    file: 'app/(app)/jobs/[id].tsx',
    name: 'default',
    bloomExport: 'JobDetailScreen',
    bloomComponent: true,
    ts: () => require('@/app/(app)/jobs/[id]'),
    bloom: () => require('./bloom/JobDetail.bloom'),
    states: {
      notFound: {
        props: {},
        before: () => {
          mockWorld.params = { id: 'j1' };
          mockWorld.auth = signedIn();
          mockWorld.job = () => ({ job: null });
        },
      },
      published: {
        props: {},
        before: () => {
          mockWorld.params = { id: 'j1' };
          mockWorld.auth = signedIn();
          mockWorld.job = () => job();
        },
      },
      draftOnMention: {
        props: {},
        before: () => {
          mockWorld.params = { id: 'j1' };
          mockWorld.auth = signedIn();
          mockWorld.job = () =>
            job({
              status: 'draft',
              applicationMode: 'mention',
              salary: { min: 20, currency: 'USD', interval: 'hour' },
              skills: [],
              location: undefined,
              workplaceType: 'remote',
            });
        },
      },
    },
  },
  {
    file: 'components/Post/PostDetailScreen.tsx',
    name: 'default',
    bloomExport: 'PostDetailScreen',
    bloomComponent: true,
    ts: () => require('@/components/Post/PostDetailScreen'),
    bloom: () => require('./bloom/PostDetailScreen.bloom'),
    states: {
      accessFailed: {
        props: { postId: 'p1' },
        before: () => {
          mockWorld.auth = signedIn();
          mockWorld.postAccess = { ...allowed, allowed: false, failed: true };
          mockWorld.detail = { cached: null, fetched: null, ancestors: [], continuations: [] };
        },
      },
      gated: {
        props: { postId: 'p1' },
        before: () => {
          mockWorld.auth = signedIn();
          mockWorld.postAccess = { ...allowed, allowed: false };
          mockWorld.detail = { cached: null, fetched: null, ancestors: [], continuations: [] };
        },
      },
      notFound: {
        props: { postId: 'p1' },
        before: () => {
          mockWorld.auth = signedIn();
          mockWorld.postAccess = allowed;
          mockWorld.detail = { cached: null, fetched: null, ancestors: [], continuations: [] };
        },
      },
      fetched: {
        props: { postId: 'p2' },
        before: () => {
          mockWorld.auth = { isAuthResolved: true, canUsePrivateApi: false };
          mockWorld.postAccess = allowed;
          mockWorld.detail = {
            cached: null,
            fetched: detailPost('p2'),
            ancestors: [],
            continuations: [],
          };
        },
      },
      reply: {
        props: { postId: 'p3' },
        before: () => {
          mockWorld.auth = signedIn();
          mockWorld.postAccess = allowed;
          mockWorld.detail = {
            cached: detailPost('p3', { parentPostId: 'p0' }),
            fetched: null,
            ancestors: [detailPost('p0')],
            continuations: [],
          };
        },
      },
    },
  },
  {
    file: 'app/(app)/notifications/pokes.tsx',
    name: 'default',
    bloomExport: 'PokesScreen',
    bloomComponent: true,
    ts: () => require('@/app/(app)/notifications/pokes'),
    bloom: () => require('./bloom/Pokes.bloom'),
    states: {
      signedOut: {
        props: {},
        before: () => {
          mockWorld.auth = { isAuthenticated: false, canUsePrivateApi: false };
        },
      },
      empty: {
        props: {},
        before: () => {
          mockWorld.auth = signedIn();
          mockWorld.pokes = { received: () => ({ pokes: [] }), sent: [], suggested: [] };
        },
      },
      error: {
        props: {},
        before: () => {
          mockWorld.auth = signedIn();
          mockWorld.pokes = {
            received: () => {
              throw new Error('down');
            },
            sent: [],
            suggested: [],
          };
        },
      },
      populated: {
        props: {},
        before: () => {
          mockWorld.auth = signedIn();
          mockWorld.pokes = {
            received: () => ({
              pokes: [
                {
                  id: 'r1',
                  user: pokeUser('1'),
                  createdAt: longAgo,
                  pokeCount: 3,
                  pokedBack: false,
                },
                {
                  id: 'r2',
                  user: pokeUser('2'),
                  createdAt: longAgo,
                  pokeCount: 1,
                  pokedBack: true,
                },
              ],
            }),
            sent: ['3', '4', '5', '6'].map((id) => ({
              id: `s${id}`,
              user: pokeUser(id),
              createdAt: longAgo,
            })),
            suggested: ['7', '8'].map((id) => ({ user: pokeUser(id) })),
          };
        },
      },
    },
  },
];

type Json = TestRenderer.ReactTestRendererJSON;

/** JSON of plain data; a React element, context, ref or class instance is named, not walked. */
function plain(value: unknown): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(value, (_key, v: unknown) => {
    if (typeof v === 'function') return undefined;
    if (v === null || typeof v !== 'object') return v;
    if ('$$typeof' in v) return '[react]';
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== Array.prototype && proto !== null)
      return `[${(v as object).constructor?.name ?? 'object'}]`;
    if (seen.has(v)) return '[cycle]';
    seen.add(v);
    return v;
  });
}

/** The host tree as lines: each view, its props (no functions, styles flattened), its text. */
function lines(node: Json | Json[] | string | null, depth = 0, out: string[] = []): string[] {
  if (node == null) return out;
  if (Array.isArray(node)) {
    for (const child of node) lines(child, depth, out);
    return out;
  }
  const pad = '  '.repeat(depth);
  if (typeof node === 'string') {
    out.push(`${pad}"${node}"`);
    return out;
  }
  const props: Record<string, unknown> = {};
  for (const key of Object.keys(node.props).sort()) {
    const value = node.props[key];
    if (typeof value === 'function' || value === undefined) continue;
    props[key] = key === 'style' ? StyleSheet.flatten(value) : value;
  }
  // React's `useId` names (`…-r3-…`) count the renders before this one, not what is drawn.
  out.push(`${pad}<${node.type} ${plain(props).replace(/-r[0-9a-z]+-/g, '-r·-')}>`);
  // Adjacent strings are one text run (a fragment's `{a}{b}` and the string `a + b` draw the same).
  const children: (Json | string)[] = [];
  for (const child of (node.children ?? []) as (Json | string)[]) {
    const last = children[children.length - 1];
    if (typeof child === 'string' && typeof last === 'string')
      children[children.length - 1] = last + child;
    else children.push(child);
  }
  for (const child of children) lines(child, depth + 1, out);
  return out;
}

/** Drawn under the app's providers, after its effects, queries and storage reads settle. */
async function draw(
  element: () => ReactElement,
  interact?: (r: TestRenderer.ReactTestRenderer) => void,
): Promise<string[]> {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <GestureHandlerRootView>
        <BloomProvider fonts={false} haptics={false} defaultMode="light">
          <QueryClientProvider client={queryClient}>
            <I18nextProvider i18n={appI18n}>{element()}</I18nextProvider>
          </QueryClientProvider>
        </BloomProvider>
      </GestureHandlerRootView>,
    );
  });
  for (let i = 0; i < 3; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
  if (interact) {
    await act(async () => interact(renderer));
    for (let i = 0; i < 3; i++) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
    }
  }
  const drawn = lines(renderer.toJSON());
  act(() => renderer.unmount());
  queryClient.clear();
  return drawn;
}

/** The TypeScript form is a component; the `.bloom` form is a view, drawn as a node. */
function element(form: 'ts' | 'bloom', c: Case, props: Props): ReactElement {
  const mod = form === 'ts' ? c.ts() : c.bloom();
  const exported = mod[form === 'ts' ? c.name : (c.bloomExport ?? c.name)] as (
    props: Props,
  ) => unknown;
  if (exported === undefined) throw new Error(`${c.file}: no export in the ${form} form`);
  if (c.call) {
    const node = exported(props);
    return isValidElement(node) ? node : (toElement(node as never) as ReactElement);
  }
  if (form === 'ts' || c.bloomComponent) return createElement(exported as never, props);
  const node = exported(props);
  return isValidElement(node) ? node : (toElement(node as never) as ReactElement);
}

/** The first differing line, with a little context, for the failure message. */
function firstDifference(a: string[], b: string[]): string {
  const at = a.findIndex((line, i) => line !== b[i]);
  const i = at === -1 ? Math.min(a.length, b.length) : at;
  const show = (xs: string[]) => xs.slice(Math.max(0, i - 3), i + 4).join('\n');
  return `line ${i + 1} (ts ${a.length} lines, bloom ${b.length})\n--- ts\n${show(a)}\n--- bloom\n${show(b)}`;
}

beforeAll(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  await initializeI18n();
  registerBloomCatalog('en', toBloomCatalog(en));
  preferBloomLocale('en-US');
});

const ROWS = CASES.flatMap((c) =>
  Object.entries(c.states).map(([state, s]) => [`${c.file}/${state}`, c, s] as const),
);

// PostDetailScreen's states take ~30 s each under Jest (its screen chrome and list).
jest.setTimeout(60_000);

describe.each(ROWS)('%s', (key, c, s) => {
  (BROKEN[key] && !process.env.PROOF_BROKEN ? it.failing : it)(
    'draws the same host tree as the TypeScript',
    async () => {
      s.before();
      mockPushes.length = 0;
      const ts = await draw(() => element('ts', c, s.props), s.interact);
      s.before();
      const bloom = await draw(() => element('bloom', c, s.props), s.interact);
      if (process.env.PROOF_DUMP)
        console.log(`${c.file}\n${ts.join('\n')}\n=====\n${bloom.join('\n')}`);
      // Vacuity floor: the root, the providers' host view and something the file drew.
      expect(ts.length).toBeGreaterThan(s.empty ? 1 : 2);
      if (ts.join('\n') !== bloom.join('\n')) throw new Error(firstDifference(ts, bloom));
    },
  );
});
