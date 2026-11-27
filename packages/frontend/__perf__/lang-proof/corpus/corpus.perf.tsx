import type { ReactElement, ReactNode } from 'react';
import { createElement } from 'react';
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
 * DEV ONLY. The corpus render check (Bloom PR #1007's handoff, ADR 0002 "Phase D: the
 * codemod's corpus"): files `bloom migrate` counts as migrated, drawn in both forms
 * with the same props and the same stand-ins, under Mention's Bloom provider, i18n
 * and React Query. A file passes when its `.bloom` form draws the same host tree as
 * the TypeScript it came from: every host view, its props (functions left out,
 * styles flattened) and its text. `./bloom/` holds the printed 2.0 text, as
 * `bloom migrate --print` wrote it, with relative imports spelled as `@/` paths.
 *
 * Run with `bun run test:perf __perf__/lang-proof/corpus`.
 */

const mockPushes: string[] = [];

/** A stand-in for a child component the file draws: a host view carrying its props. */
function mockStub(name: string) {
  return function Stub(props: Record<string, unknown>) {
    const { children, ...rest } = props;
    return createElement(
      View,
      {
        testID: `stub:${name}`,
        accessibilityHint: JSON.stringify(rest, (_k, v) =>
          typeof v === 'object' && v && '$$typeof' in v ? '[react]' : v,
        ),
      },
      children as ReactNode,
    );
  };
}

jest.mock('@/lib/navigation/router', () => ({
  Link: ({ children }: { children: ReactNode }) => children,
  useRouter: () => ({
    push: (href: string) => mockPushes.push(href),
    back: () => mockPushes.push('<back>'),
    replace: (href: string) => mockPushes.push(href),
    canGoBack: () => false,
  }),
  useLocalSearchParams: () => ({}),
}));
jest.mock('@/components/Feed/Feed', () => ({ __esModule: true, default: mockStub('Feed') }));
jest.mock('@/components/Feed/PostItem.bloom', () => ({
  __esModule: true,
  PostItem: mockStub('PostItem'),
}));
jest.mock('@/components/Post/CompactReplyComposer', () => ({
  CompactReplyComposer: mockStub('CompactReplyComposer'),
}));
jest.mock('@/components/Podcast/PodcastCard', () => ({ PodcastCard: mockStub('PodcastCard') }));
jest.mock('@/components/Podcast/PodcastSaveButton', () => ({
  PodcastSaveButton: mockStub('PodcastSaveButton'),
}));
jest.mock('@/components/FollowButton', () => ({ FollowButton: mockStub('FollowButton') }));
jest.mock('@/components/interests/TopicPicker', () => ({ TopicPicker: mockStub('TopicPicker') }));
jest.mock('@/components/welcome/WelcomeStarterPacks', () => ({
  WelcomeStarterPacks: mockStub('WelcomeStarterPacks'),
}));
jest.mock('@/components/sharedRouteScreens', () => ({
  LazyWhoToFollowTab: mockStub('LazyWhoToFollowTab'),
}));
jest.mock('@/hooks/useWelcome', () => ({
  useCompleteWelcome: () => ({ mutate: () => undefined, isPending: false }),
}));
jest.mock('@/hooks/useSupervisionState', () => ({
  useSupervisionState: () => ({ isSupervised: false, restrictions: {} }),
}));

/** The mockWorld the hooks read; each case sets the part it needs before drawing. */
const mockWorld: {
  podcast: { status: string; value?: unknown };
  rooms: unknown[];
  recommendations: unknown[];
  recommendationsLoading: boolean;
} = {
  podcast: { status: 'loading' },
  rooms: [],
  recommendations: [],
  recommendationsLoading: false,
};

jest.mock('@/hooks/useVisibleReference', () => ({
  useVisibleReference: () => mockWorld.podcast,
}));
jest.mock('@/stores/liveRoomsStore', () => {
  const startPolling = () => 'sub';
  const stopPolling = () => undefined;
  const hideRoom = () => undefined;
  return {
    useLiveRoomsStore: () => ({
      rooms: mockWorld.rooms,
      hasFetched: true,
      error: null,
      hiddenRoomIds: [],
      startPolling,
      stopPolling,
      hideRoom,
    }),
  };
});
jest.mock('@/hooks/useCachedUser', () => ({
  useUserById: (id: string) => ({
    id,
    username: `user-${id}`,
    name: { displayName: `User ${id}` },
  }),
  useCachedUserSnapshot: () => undefined,
}));
jest.mock('@/hooks/useRecommendations', () => ({
  useRecommendations: () => ({
    recommendations: mockWorld.recommendations,
    isLoading: mockWorld.recommendationsLoading,
  }),
}));

type Props = Record<string, unknown>;
type Module = Record<string, unknown>;

interface Case {
  /** The corpus file, relative to `packages/frontend`. */
  file: string;
  /** The exported name, the same in both forms. */
  name: string;
  /** The `.bloom` form's export, when it is not `name` (bloomc writes a `Screen` as the default). */
  bloomExport?: string;
  /** The `.bloom` form is a component (a `Screen`), not a view. */
  bloomComponent?: boolean;
  /**
   * Why the `.bloom` form draws wrongly (Bloom repros in ~/.local/share/bloom-lang/repros/mention5):
   * its states are expected to fail until it is fixed, and then fail here as passing.
   */
  broken?: string;
  ts: () => Module;
  bloom: () => Module;
  states: Record<string, { props: Props; before?: () => void }>;
}

const room = (id: string, title: string, type: 'talk' | 'stage' | 'broadcast') => ({
  _id: id,
  title,
  host: `h${id}`,
  type,
  status: 'live',
  participants: ['a', 'b', 'c'],
  speakers: ['a'],
});
const profile = (id: string) => ({
  id,
  username: `user${id}`,
  name: { displayName: `User ${id}` },
  avatar: null,
  verified: id === '1',
});
const post = {
  id: 'p1',
  content: { text: 'A post a note is about' },
  user: { id: 'u1', username: 'author', name: { displayName: 'Author' } },
};

const CASES: Case[] = [
  {
    file: 'components/videos/VideoReplies.tsx',
    name: 'VideoReplies',
    ts: () => require('@/components/videos/VideoReplies'),
    bloom: () => require('./bloom/VideoReplies.bloom'),
    states: { signedOut: { props: { postId: 'p1' } } },
  },
  {
    file: 'components/Error.tsx',
    name: 'Error',
    ts: () => require('@/components/Error'),
    bloom: () => require('./bloom/Error.bloom'),
    states: {
      defaults: { props: {} },
      retry: { props: { title: 'Gone', message: 'Try later', onRetry: async () => undefined } },
    },
  },
  {
    // Without the back button there is no conditional node (R2), so it draws right.
    file: 'components/Error.tsx',
    name: 'Error',
    ts: () => require('@/components/Error'),
    bloom: () => require('./bloom/Error.bloom'),
    states: { noBack: { props: { hideBackButton: true, style: { margin: 4 } } } },
  },
  {
    file: 'components/Podcast/PostPodcastAttachment.tsx',
    name: 'PostPodcastAttachment',
    ts: () => require('@/components/Podcast/PostPodcastAttachment'),
    bloom: () => require('./bloom/PostPodcastAttachment.bloom'),
    states: {
      loading: {
        props: { podcast: { syraPodcastId: 'pod1' }, postId: 'p1', width: 320 },
        before: () => {
          mockWorld.podcast = { status: 'loading' };
        },
      },
      ready: {
        props: { podcast: { syraPodcastId: 'pod1' }, postId: 'p1', width: '100%', height: 180 },
        before: () => {
          mockWorld.podcast = { status: 'ready', value: { id: 'pod1', title: 'A podcast' } };
        },
      },
      readyNoSave: {
        props: { podcast: { syraPodcastId: 'pod1' }, width: 300, showSaveButton: false },
        before: () => {
          mockWorld.podcast = { status: 'ready', value: { id: 'pod1', title: 'A podcast' } };
        },
      },
      missing: {
        props: { podcast: { syraPodcastId: 'pod1' }, width: 300 },
        before: () => {
          mockWorld.podcast = { status: 'missing' };
        },
      },
    },
  },
  {
    file: 'components/Profile/ProfileSkeleton.tsx',
    name: 'ProfileSkeleton',
    ts: () => require('@/components/Profile/ProfileSkeleton'),
    bloom: () => require('./bloom/ProfileSkeleton.bloom'),
    states: { defaults: { props: {} } },
  },
  {
    file: 'components/rooms/RoomsListSkeleton.tsx',
    name: 'RoomsListSkeleton',
    ts: () => require('@/components/rooms/RoomsListSkeleton'),
    bloom: () => require('./bloom/RoomsListSkeleton.bloom'),
    states: { defaults: { props: {} } },
  },
  {
    file: 'components/welcome/WelcomeScreen.tsx',
    name: 'WelcomeScreen',
    ts: () => require('@/components/welcome/WelcomeScreen'),
    bloom: () => require('./bloom/WelcomeScreen.bloom'),
    bloomComponent: true,
    states: { first: { props: {} } },
  },
  {
    file: 'components/CommunityNotes/WriteNoteSheet.tsx',
    name: 'WriteNoteSheet',
    ts: () => require('@/components/CommunityNotes/WriteNoteSheet'),
    bloom: () => require('./bloom/WriteNoteSheet.bloom'),
    states: {
      empty: { props: { post, onSubmit: () => undefined, onClose: () => undefined } },
    },
  },
  {
    file: 'components/Profile/ExperienceEmployerField.tsx',
    name: 'ExperienceEmployerField',
    ts: () => require('@/components/Profile/ExperienceEmployerField'),
    bloom: () => require('./bloom/ExperienceEmployerField.bloom'),
    states: {
      empty: { props: { value: '', disabled: false, invalid: false, onChange: () => undefined } },
      initial: {
        props: {
          value: 'org1',
          initialEmployer: { id: 'org1', name: 'Acme', type: 'company' },
          disabled: true,
          invalid: true,
          onChange: () => undefined,
        },
      },
    },
  },
  {
    file: 'components/SuggestedProfileCard.tsx',
    name: 'SuggestedProfileCard',
    ts: () => require('@/components/SuggestedProfileCard'),
    bloom: () => require('./bloom/SuggestedProfileCard.bloom'),
    states: {
      plain: { props: { profile: { ...profile('1'), description: 'Writes about things' } } },
      noBio: { props: { profile: profile('2'), onPress: () => undefined } },
    },
  },
  {
    file: 'components/SuggestedProfileCard.tsx',
    name: 'SuggestedProfileCardSkeleton',
    ts: () => require('@/components/SuggestedProfileCard'),
    bloom: () => require('./bloom/SuggestedProfileCard.bloom'),
    states: { defaults: { props: {} } },
  },
  {
    file: 'components/notifications/NotificationSkeleton.tsx',
    name: 'NotificationSkeleton',
    ts: () => require('@/components/notifications/NotificationSkeleton'),
    bloom: () => require('./bloom/NotificationSkeleton.bloom'),
    states: { defaults: { props: {} }, three: { props: { count: 3 } } },
  },
  {
    file: 'components/widgets/LiveRoomsWidget.tsx',
    name: 'LiveRoomsWidget',
    ts: () => require('@/components/widgets/LiveRoomsWidget'),
    bloom: () => require('./bloom/LiveRoomsWidget.bloom'),
    states: {
      none: {
        props: {},
        before: () => {
          mockWorld.rooms = [];
        },
      },
      rooms: {
        props: { divider: true },
        before: () => {
          mockWorld.rooms = [
            room('1', 'Morning talk', 'talk'),
            room('2', 'A stage', 'stage'),
            room('3', 'Broadcast', 'broadcast'),
            room('4', 'A fourth', 'talk'),
          ];
        },
      },
    },
  },
  {
    file: 'components/widgets/WhoToFollowWidget.tsx',
    name: 'WhoToFollowWidget',
    ts: () => require('@/components/widgets/WhoToFollowWidget'),
    bloom: () => require('./bloom/WhoToFollowWidget.bloom'),
    states: {
      loading: {
        props: {},
        before: () => {
          mockWorld.recommendationsLoading = true;
          mockWorld.recommendations = [];
        },
      },
      loaded: {
        props: { divider: true },
        before: () => {
          mockWorld.recommendationsLoading = false;
          mockWorld.recommendations = ['1', '2', '3', '4'].map(profile);
        },
      },
      empty: {
        props: {},
        before: () => {
          mockWorld.recommendationsLoading = false;
          mockWorld.recommendations = [];
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
  for (const child of node.children ?? []) lines(child as Json | string, depth + 1, out);
  return out;
}

function draw(element: ReactElement): string[] {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(
      <GestureHandlerRootView>
        <BloomProvider fonts={false} haptics={false} defaultMode="light">
          <QueryClientProvider client={queryClient}>
            <I18nextProvider i18n={appI18n}>{element}</I18nextProvider>
          </QueryClientProvider>
        </BloomProvider>
      </GestureHandlerRootView>,
    );
  });
  const drawn = lines(renderer.toJSON());
  act(() => renderer.unmount());
  return drawn;
}

/** The TypeScript form is a component; the `.bloom` form is a view, drawn as a node. */
function element(form: 'ts' | 'bloom', c: Case, props: Props): ReactElement {
  const mod = form === 'ts' ? c.ts() : c.bloom();
  const exported = mod[form === 'ts' ? c.name : (c.bloomExport ?? c.name)] as (
    props: Props,
  ) => unknown;
  if (form === 'ts' || c.bloomComponent) return createElement(exported as never, props);
  return toElement(exported(props) as never) as ReactElement;
}

/** The first differing line, with a little context, for the failure message. */
function firstDifference(a: string[], b: string[]): string {
  const at = a.findIndex((line, i) => line !== b[i]);
  const i = at === -1 ? Math.min(a.length, b.length) : at;
  const show = (xs: string[]) => xs.slice(Math.max(0, i - 2), i + 3).join('\n');
  return `line ${i + 1} (ts ${a.length} lines, bloom ${b.length})\n--- ts\n${show(a)}\n--- bloom\n${show(b)}`;
}

beforeAll(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  await initializeI18n();
  if (process.env.PROOF_NO_CATALOG !== '1') {
    // As lib/i18n.ts registers the app's catalogs (`PROOF_NO_CATALOG=1` draws the keys).
    registerBloomCatalog('en', toBloomCatalog(en));
    preferBloomLocale('en-US');
  }
});

const ROWS = CASES.flatMap((c) =>
  Object.entries(c.states).map(([state, s]) => [`${c.name}/${state}`, c, s] as const),
);

describe.each(ROWS)('%s', (_key, c, s) => {
  (c.broken && !process.env.PROOF_BROKEN ? it.failing : it)(
    'draws the same host tree as the TypeScript',
    () => {
      s.before?.();
      mockPushes.length = 0;
      const ts = draw(element('ts', c, s.props));
      s.before?.();
      const bloom = draw(element('bloom', c, s.props));
      if (process.env.PROOF_DUMP)
        console.log(`${c.name}\n${ts.join('\n')}\n=====\n${bloom.join('\n')}`);
      expect(ts.length).toBeGreaterThan(0);
      if (ts.join('\n') !== bloom.join('\n')) throw new Error(firstDifference(ts, bloom));
    },
  );
});
