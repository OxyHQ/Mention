import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

/**
 * WHO MOVES THE CHROME, AND HOW OFTEN THE JS THREAD HEARS ABOUT IT.
 *
 * The auto-hiding header, the home tab strip and the bottom bar integrate their
 * position from the shared `scrollPosition` inside a `useAnimatedReaction`
 * worklet. That worklet runs on the UI thread, so the chrome tracks the finger
 * exactly as well as the VALUE IT READS is kept up to date — and that value used
 * to be written from a JS `onScroll` callback. During a fling the JS thread is
 * busy building rows (~40ms each, measured on a Pixel 10 Pro), so the offset
 * arrived in bursts and the header froze and then jumped.
 *
 * Two halves, and the test needs both or it means nothing:
 *
 *  1. THE SHARED VALUE MOVES ON EVERY SCROLL EVENT — otherwise the chrome is
 *     still as coarse as before, just from a different thread.
 *  2. THE JS THREAD IS NOT TOLD EVERY TIME — otherwise nothing was actually
 *     taken off the hot path and the fling still pays for the bookkeeping.
 *
 * Plus the part that keeps (2) honest: what gets PERSISTED when the scroll stops
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
}));

jest.mock('@shopify/flash-list', () => {
    const React_ = require('react') as typeof import('react');
    const { View: RNView } = require('react-native') as typeof import('react-native');
    const FlashList = React_.forwardRef<unknown, { children?: React.ReactNode }>(
        (props, ref) => {
            React_.useImperativeHandle(ref, () => ({ scrollToOffset: () => undefined }));
            return React_.createElement(RNView, null, props.children);
        },
    );
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

jest.mock('@oxyhq/services/ui/client', () => ({
    useAuth: () => ({
        user: { id: 'reader' },
        isAuthenticated: true,
        canUsePrivateApi: true,
        signIn: jest.fn(),
    }),
}));

jest.mock('@oxyhq/bloom/theme', () => ({
    useTheme: () => ({ colors: { primary: '#1d9bf0', border: '#e1e8ed', background: '#fff' } }),
}));
jest.mock('@oxyhq/bloom/error-boundary', () => ({
    ErrorBoundary: ({ children }: { children?: React.ReactNode }) => children ?? null,
}));
jest.mock('@oxyhq/bloom/scroll', () => ({ useScrollRestoration: () => undefined }));

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

// eslint-disable-next-line import/first -- every mock above must be installed first.
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
        mockScrollPosition.value = 0;
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

    it('moves the shared scroll position on every single event', () => {
        for (const offset of [4, 9, 17, 26, 38]) scrollTo(offset);

        // Not "eventually 38" — the chrome integrates a DELTA per frame, so a
        // value that only lands on some frames is a chrome that only moves on
        // some frames.
        expect(mockScrollPosition.value).toBe(38);
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
