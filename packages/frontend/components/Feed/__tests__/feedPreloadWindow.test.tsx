jest.mock('@/hooks/useFeedVisibility', () => ({ useFeedVisibility: jest.fn() }));
jest.mock('@/services/socketService', () => ({
  socketService: { subscribeToFeedUpdates: jest.fn(() => jest.fn()) },
}));
jest.mock('@oxy.so/bloom/screen', () => ({
  ...jest.requireActual('@oxy.so/bloom/screen'),
  useScreenViewport: () => null,
  // The feed hands Bloom its scroll handler; Bloom's own chrome is not under test.
  useScreenScroll: ({ handler }: { handler?: unknown }) => ({
    onScroll: handler,
    contentInsets: { top: 0, bottom: 0 },
    scrollY: { value: 0 },
  }),
}));
import type React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

/**
 * THE PRELOAD WINDOW: which rows may hold a loaded video player before they are
 * on screen. The viewable rows, two below the last and one above the first,
 * published beside the viewable keys; and a moment with no viewable row (one
 * row left, the next not yet reported) keeps the window it had.
 */

const scrollHandlers: {
  onScroll?: (event: { contentOffset: { y: number } }) => void;
  onEndDrag?: (event: { contentOffset: { y: number } }) => void;
  onMomentumEnd?: (event: { contentOffset: { y: number } }) => void;
} = {};

jest.mock('react-native-reanimated', () => {
  const React_ = require('react') as typeof import('react');
  const { View: RNView } = require('react-native') as typeof import('react-native');
  return {
    __esModule: true,
    default: {
      createAnimatedComponent: (component: unknown) => component,
      View: RNView,
    },
    // The handlers are captured rather than run: a worklet's whole point is
    // that it executes somewhere this test cannot follow, so the contract
    // under test is what it DOES when the UI thread calls it.
    useAnimatedScrollHandler: (handlers: typeof scrollHandlers) => {
      Object.assign(scrollHandlers, handlers);
      return handlers;
    },
    useSharedValue: (initial: number) => React_.useRef({ value: initial }).current,
    // `runOnJS` hops a worklet's call back to the JS thread; under jest there
    // is only one thread, so it is the identity.
    runOnJS: (fn: (...args: never[]) => unknown) => fn,
  };
});

const mockSetFeedScrollOffset = jest.fn();

jest.mock('@/stores/feedScrollStore', () => ({
  getFeedScrollOffset: () => 0,
  setFeedScrollOffset: (...args: unknown[]) => mockSetFeedScrollOffset(...args),
  getLocalPostRevision: () => 0,
  subscribeToLocalPostRevision: () => () => undefined,
}));

const mockList: { onViewableItemsChanged?: (info: { viewableItems: unknown[] }) => void } = {};
jest.mock('@shopify/flash-list', () => {
  const React_ = require('react') as typeof import('react');
  const { View: RNView } = require('react-native') as typeof import('react-native');
  const FlashList = React_.forwardRef<unknown, { children?: React.ReactNode }>((props, ref) => {
    React_.useImperativeHandle(ref, () => ({ scrollToOffset: () => undefined }));
    mockList.onViewableItemsChanged = (props as typeof mockList).onViewableItemsChanged;
    return React_.createElement(RNView, null, props.children);
  });
  FlashList.displayName = 'MockFlashList';
  return { __esModule: true, FlashList };
});

jest.mock('@/hooks/useFeedState', () => ({
  useFeedState: () => ({
    items: [],
    slices: undefined,
    interstitials: undefined,
    hasMore: false,
    isLoading: false,
    error: null,
    feedScrollKey: 'for_you',
    refresh: jest.fn(),
    loadMore: jest.fn(),
    clearError: jest.fn(),
    fetchInitial: jest.fn(),
  }),
}));

jest.mock('@oxy.so/services/ui/client', () => ({
  useAuth: () => ({
    user: { id: 'reader' },
    isAuthenticated: true,
    canUsePrivateApi: true,
    signIn: jest.fn(),
  }),
}));

jest.mock('@oxy.so/bloom/theme', () => ({
  useTheme: () => ({ colors: { primary: '#1d9bf0', border: '#e1e8ed', background: '#fff' } }),
}));
jest.mock('@oxy.so/bloom/error-boundary', () => ({
  ErrorBoundary: ({ children }: { children?: React.ReactNode }) => children ?? null,
}));
jest.mock('@oxy.so/bloom/scroll', () => ({ useScrollRestoration: () => undefined }));
jest.mock('@oxy.so/bloom/layout', () => ({ useHeaderDockInset: () => 0 }));

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn() }),
  useIsFocused: () => true,
}));

jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

jest.mock('@/hooks/usePrivacyControls', () => ({
  usePrivacyControls: () => ({ blockedSet: new Set<string>() }),
}));

jest.mock('@/utils/feedTelemetry', () => ({
  resolveFeedDescriptor: () => 'for_you',
  useFeedImpressionTracker: () => ({ current: { syncVisible: jest.fn() } }),
}));

const mockPublish = jest.fn();
jest.mock('@oxy.so/bloom/video-playback', () => ({
  createViewableKeysStore: () => ({ publish: mockPublish }),
  VideoViewabilityProvider: ({ children }: { children?: React.ReactNode }) => children ?? null,
  VideoViewabilityScope: ({ children }: { children?: React.ReactNode }) => children ?? null,
}));

/**
 * The rows themselves are out of scope here, and importing them is not free: the
 * chain `feedRows → PostItem → postsStore → feedService` reaches the SDK, which
 * ships ESM this transform does not take.
 */
// Eight post rows, p0..p7.
const mockRows = Array.from({ length: 8 }, (_, index) => ({
  kind: 'post',
  key: `p${index}`,
  item: { id: `p${index}` },
}));
jest.mock('@/utils/feedUtils', () => ({
  ...jest.requireActual('@/utils/feedUtils'),
  getItemKey: (item: { id: string }) => item.id,
}));
jest.mock('../feedRows', () => ({
  buildFeedRows: () => mockRows,
  renderFeedRow: () => null,
  feedRowKey: (row: { key?: string }) => row.key ?? 'row',
  feedRowType: () => 'post',
  feedRowStyles: { container: {}, list: {}, listEmbedded: {}, listContent: {} },
}));

jest.mock('../FeedHeader', () => ({ FeedHeader: () => null }));
jest.mock('../FeedFooter', () => ({ FeedFooter: () => null }));
jest.mock('../FeedEmptyState', () => ({ FeedEmptyState: () => null }));

// Every mock above must be installed first.
import Feed from '../Feed.native';

const showing = (...indices: number[]) =>
  act(() => {
    mockList.onViewableItemsChanged?.({
      viewableItems: indices.map((index) => ({ index, isViewable: true, item: mockRows[index] })),
    });
  });
const lastPublished = () => {
  const [keys, near] = mockPublish.mock.calls[mockPublish.mock.calls.length - 1] as [
    Set<string>,
    Set<string>,
  ];
  return { keys: [...keys], near: [...near].sort() };
};

describe('the preload window', () => {
  let renderer: TestRenderer.ReactTestRenderer | undefined;
  beforeEach(() => {
    mockPublish.mockClear();
    act(() => {
      renderer = TestRenderer.create(<Feed type="for_you" />);
    });
  });
  afterEach(() => {
    act(() => renderer?.unmount());
  });

  it('is the rows around the viewable ones, and only the viewable ones are visible', () => {
    showing(3, 4);
    expect(lastPublished()).toEqual({ keys: ['p3', 'p4'], near: ['p2', 'p5', 'p6'] });
  });

  it('stops at the ends of the list', () => {
    showing(0);
    expect(lastPublished().near).toEqual(['p1', 'p2']);
    showing(7);
    expect(lastPublished().near).toEqual(['p6']);
  });

  it('keeps its rows through a moment with nothing viewable', () => {
    showing(3);
    showing();
    // The row about to be reported keeps the player it preloaded.
    expect(lastPublished()).toEqual({ keys: [], near: ['p2', 'p4', 'p5'] });
    showing(4);
    expect(lastPublished()).toEqual({ keys: ['p4'], near: ['p3', 'p5', 'p6'] });
  });
});
