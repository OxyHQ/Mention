import type React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

/**
 * AN ANONYMOUS READER KEEPS SCROLLING; NOTHING OPENS SIGN-IN FOR THEM.
 *
 * The native feed used to answer `onEndReached` for an anonymous reader with
 * `signIn()` instead of the next page. With a 1000px draw distance the first
 * page's end is in range after one fling, so the SDK sign-in sheet opened by
 * itself over public browse (found measuring #1103 on a Pixel 8a). Web never
 * did this; the footer's tap is the only sign-in affordance on both.
 */

const mockList: { onEndReached?: () => void } = {};
const mockLoadMore = jest.fn();
const mockSignIn = jest.fn(() => Promise.resolve());
const mockAuth = { authenticated: false };

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

const mockScrollPosition = { value: 0 };
const mockSetFeedScrollOffset = jest.fn();

jest.mock('@/context/LayoutScrollContext', () => ({
  useLayoutScroll: () => ({
    scrollPosition: mockScrollPosition,
    scrollEventThrottle: 16,
    registerScrollable: () => () => undefined,
  }),
}));

jest.mock('@/stores/feedScrollStore', () => ({
  getFeedScrollOffset: () => 0,
  setFeedScrollOffset: (...args: unknown[]) => mockSetFeedScrollOffset(...args),
  getLocalPostRevision: () => 0,
  subscribeToLocalPostRevision: () => () => undefined,
}));

jest.mock('@shopify/flash-list', () => {
  const React_ = require('react') as typeof import('react');
  const { View: RNView } = require('react-native') as typeof import('react-native');
  const FlashList = React_.forwardRef<
    unknown,
    { children?: React.ReactNode; onEndReached?: () => void }
  >((props, ref) => {
    React_.useImperativeHandle(ref, () => ({ scrollToOffset: () => undefined }));
    mockList.onEndReached = props.onEndReached;
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
    hasMore: true,
    isLoading: false,
    error: null,
    feedScrollKey: 'for_you',
    refresh: jest.fn(),
    loadMore: mockLoadMore,
    clearError: jest.fn(),
    fetchInitial: jest.fn(),
  }),
}));

jest.mock('@oxy.so/services/ui/client', () => ({
  useAuth: () => ({
    user: mockAuth.authenticated ? { id: 'reader' } : null,
    isAuthenticated: mockAuth.authenticated,
    canUsePrivateApi: mockAuth.authenticated,
    signIn: mockSignIn,
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

jest.mock('@/context/VideoPlaybackContext', () => ({
  VideoViewabilityProvider: ({ children }: { children?: React.ReactNode }) => children ?? null,
  VideoViewabilityScope: ({ children }: { children?: React.ReactNode }) => children ?? null,
}));

/**
 * The rows themselves are out of scope here, and importing them is not free: the
 * chain `feedRows → PostItem → postsStore → feedService` reaches the SDK, which
 * ships ESM this transform does not take.
 */
jest.mock('../feedRows', () => ({
  buildFeedRows: () => [],
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

describe('reaching the end of a page', () => {
  let renderer: TestRenderer.ReactTestRenderer | undefined;

  function mount() {
    act(() => {
      renderer = TestRenderer.create(<Feed type="for_you" />);
    });
  }

  afterEach(() => {
    act(() => {
      renderer?.unmount();
    });
    renderer = undefined;
    mockLoadMore.mockClear();
    mockSignIn.mockClear();
  });

  it('loads the next page for an anonymous reader and never opens sign-in', () => {
    mockAuth.authenticated = false;
    mount();
    act(() => {
      mockList.onEndReached?.();
    });
    expect(mockLoadMore).toHaveBeenCalledTimes(1);
    expect(mockSignIn).not.toHaveBeenCalled();
  });

  it('loads the next page for a signed-in reader', () => {
    mockAuth.authenticated = true;
    mount();
    act(() => {
      mockList.onEndReached?.();
    });
    expect(mockLoadMore).toHaveBeenCalledTimes(1);
    expect(mockSignIn).not.toHaveBeenCalled();
  });
});
