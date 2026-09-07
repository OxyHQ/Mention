import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { Text } from 'react-native';

/**
 * The notifications list scrolls for ONE consumer: the auto-hiding chrome, which
 * integrates its position from the shared `scrollPosition` inside a UI-thread
 * worklet. So the offset has no business crossing to the JS thread — and while
 * it did, it could only cross when the JS thread was free, which on a tab whose
 * rows carry avatars and text is exactly when it is not.
 */

const scrollHandlers: { onScroll?: (event: { contentOffset: { y: number } }) => void } = {};

jest.mock('react-native-reanimated', () => ({
    __esModule: true,
    default: { createAnimatedComponent: (component: unknown) => component },
    useAnimatedScrollHandler: (handlers: typeof scrollHandlers) => {
        Object.assign(scrollHandlers, handlers);
        return handlers;
    },
}));

const mockScrollPosition = { value: 0 };
/** Present so the test can prove it is NOT what the list drives any more. */
const mockHandleScroll = jest.fn();

jest.mock('@/context/LayoutScrollContext', () => ({
    useLayoutScroll: () => ({
        scrollPosition: mockScrollPosition,
        scrollEventThrottle: 16,
        registerScrollable: () => () => undefined,
        handleScroll: mockHandleScroll,
    }),
}));

jest.mock('@shopify/flash-list', () => {
    const React_ = require('react') as typeof import('react');
    const { View } = require('react-native') as typeof import('react-native');
    const FlashList = React_.forwardRef<unknown, { children?: React.ReactNode }>((props, ref) => {
        React_.useImperativeHandle(ref, () => ({ scrollToOffset: () => undefined }));
        return React_.createElement(View, null, props.children);
    });
    FlashList.displayName = 'MockFlashList';
    return { __esModule: true, FlashList };
});

jest.mock('@oxyhq/bloom/theme', () => ({
    useTheme: () => ({ colors: { primary: '#1d9bf0', background: '#fff' } }),
}));
jest.mock('@oxyhq/bloom/loading', () => ({ Loading: () => null }));

// eslint-disable-next-line import/first -- the mocks above must be installed first.
import { NotificationsList } from '../NotificationsList.native';

describe('the notifications list’s scroll', () => {
    it('writes the shared position from the scroll worklet, never through JS', () => {
        let renderer!: TestRenderer.ReactTestRenderer;
        act(() => {
            renderer = TestRenderer.create(
                <NotificationsList
                    items={[]}
                    renderRow={() => <Text>row</Text>}
                    header={null}
                    emptyState={<Text>empty</Text>}
                    tabKey="all"
                    refreshing={false}
                    onRefresh={() => undefined}
                />,
            );
        });

        act(() => {
            scrollHandlers.onScroll?.({ contentOffset: { y: 64 } });
        });

        expect(mockScrollPosition.value).toBe(64);
        // The other half: a list that ALSO reported through JS would still be
        // paying for the callback this change exists to remove.
        expect(mockHandleScroll).not.toHaveBeenCalled();

        act(() => {
            renderer.unmount();
        });
    });
});
