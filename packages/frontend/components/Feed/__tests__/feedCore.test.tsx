import React from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import TestRenderer, { act } from 'react-test-renderer';

/**
 * ONE FEED CORE, TWO SCROLLERS.
 *
 * The native and web Feeds differ only in how they virtualize; everything a feed
 * shows and does lives in `useFeedCore`. These cases pin the behaviours that
 * used to exist on one platform only, and the source shape that keeps them
 * from forking again.
 */

const mockList: { onEndReached?: () => void; data?: Array<{ kind: string; key?: string }> } = {};
const mockLoadMore = jest.fn();
const mockSignIn = jest.fn(() => Promise.resolve());
const mockAuth = { authenticated: true };
const mockFeed = { isLoading: true };

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
    mockList.data = (props as { data?: Array<{ kind: string; key?: string }> }).data;
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
    isLoading: mockFeed.isLoading,
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

jest.mock('@/components/shell/PanelChrome', () => ({
  usePanelChromeTopInset: () => 0,
  PANEL_HEADER_HEIGHT: 56,
  PANEL_CHROME_TOP_INSET: 56,
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

const leadingKeys = () =>
  (mockList.data ?? []).filter((row) => row.kind === 'auxiliary').map((row) => row.key);

describe('a pinned post holds the first presentation on native too (#1216)', () => {
  let renderer: TestRenderer.ReactTestRenderer | undefined;
  afterEach(() => {
    act(() => {
      renderer?.unmount();
    });
    renderer = undefined;
  });

  const pinned = React.createElement('pinned-post');

  it('keeps the pinned post out while it is still being fetched', () => {
    mockFeed.isLoading = true;
    act(() => {
      renderer = TestRenderer.create(
        <Feed type="for_you" listLeadingComponent={pinned} leadingPending />,
      );
    });
    expect(leadingKeys()).not.toContain('leading');
  });

  it('shows it once both it and the first page are known', () => {
    mockFeed.isLoading = false;
    act(() => {
      renderer = TestRenderer.create(
        <Feed type="for_you" listLeadingComponent={pinned} leadingPending={false} />,
      );
    });
    expect(leadingKeys()).toContain('leading');
  });
});

describe('the platform Feeds share one core', () => {
  const read = (file: string) => readFileSync(join(__dirname, '..', file), 'utf8');

  it.each(['Feed.native.tsx', 'Feed.web.tsx'])(
    '%s takes its data and behaviour from useFeedCore',
    (file) => {
      const source = read(file);
      expect(source).toMatch(/useFeedCore\(props\)/);
      // Reading feed state, auth or building rows here again is a fork.
      expect(source).not.toMatch(/\buseFeedState\(|\buseAuth\(|\bbuildFeedRows\(|\bsignIn\(/);
    },
  );
});
