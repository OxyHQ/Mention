jest.mock('@/hooks/useFeedVisibility', () => ({ useFeedVisibility: jest.fn() }));
jest.mock('@/services/socketService', () => ({
  socketService: { subscribeToFeedUpdates: jest.fn(() => jest.fn()) },
}));
jest.mock('@oxy.so/bloom/screen', () => ({
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
 * HOW OFTEN THE JS THREAD HEARS ABOUT THE SCROLL.
 *
 * The chrome follows the feed on the UI thread: the feed hands its scroll to
 * Bloom's `useScreenScroll` as a worklet. The JS side only needs the offset for
 * bookkeeping (where to reopen the feed), and during a fling the JS thread is
 * busy building rows (~40ms each, measured on a Pixel 10 Pro), so it must not
 * be told on every event.
 *
 * Plus the part that keeps that honest: what gets PERSISTED when the scroll stops
 * is the offset the reader actually stopped at, not the last rationed sample.
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

jest.mock('@shopify/flash-list', () => {
  const React_ = require('react') as typeof import('react');
  const { View: RNView } = require('react-native') as typeof import('react-native');
  const FlashList = React_.forwardRef<unknown, { children?: React.ReactNode }>((props, ref) => {
    React_.useImperativeHandle(ref, () => ({ scrollToOffset: () => undefined }));
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

/** One screen of travel, sampled the way a scroll actually arrives. */
function scrollTo(offset: number) {
  act(() => {
    scrollHandlers.onScroll?.({ contentOffset: { y: offset } });
  });
}

describe('the feed’s scroll, as the chrome and the JS thread each see it', () => {
  let renderer: TestRenderer.ReactTestRenderer | undefined;

  beforeEach(() => {
    mockSetFeedScrollOffset.mockClear();
    act(() => {
      renderer = TestRenderer.create(<Feed type="for_you" />);
    });
  });

  afterEach(() => {
    act(() => {
      renderer?.unmount();
    });
    renderer = undefined;
  });

  it('does not tell the JS thread about every one of them', () => {
    for (const offset of [4, 9, 17, 26, 38, 51, 63, 74, 88, 99]) scrollTo(offset);

    // A hundred pixels of travel is not a hundred pixels' worth of work:
    // nothing on the JS side is answering a different question yet.
    expect(mockSetFeedScrollOffset).not.toHaveBeenCalled();
  });

  it('tells it once the reader has actually travelled', () => {
    scrollTo(60);
    scrollTo(130);
    scrollTo(200);

    // 120px is the ration; 130 crosses it and 200 has not yet crossed the
    // next one.
    expect(mockSetFeedScrollOffset).toHaveBeenCalledTimes(1);
    expect(mockSetFeedScrollOffset).toHaveBeenCalledWith('for_you', 130);
  });

  it('persists where the reader stopped, not the last rationed sample', () => {
    scrollTo(130);
    mockSetFeedScrollOffset.mockClear();

    scrollTo(190);
    act(() => {
      scrollHandlers.onMomentumEnd?.({ contentOffset: { y: 190 } });
    });

    // Reopening the feed 60px above where it was left is exactly the kind of
    // small wrongness a coarse-only report would ship.
    expect(mockSetFeedScrollOffset).toHaveBeenCalledWith('for_you', 190);
  });

  it('persists the resting offset after a drag that never gained momentum', () => {
    scrollTo(300);
    mockSetFeedScrollOffset.mockClear();

    act(() => {
      scrollHandlers.onEndDrag?.({ contentOffset: { y: 341 } });
    });

    expect(mockSetFeedScrollOffset).toHaveBeenCalledWith('for_you', 341);
  });
});
