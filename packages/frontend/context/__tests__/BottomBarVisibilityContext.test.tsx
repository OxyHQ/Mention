import React from 'react';
import { Animated } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import type { SharedValue } from 'react-native-reanimated';

import {
    BottomBarVisibilityProvider,
    useBottomBarHidden,
} from '@/context/BottomBarVisibilityContext';

// Drive the shared scrollY directly so we can assert how the provider maps
// scroll position → the `hidden` auto-hide signal, without a real scroller.
// `mock`-prefixed so jest's mock factory may reference it.
const mockScrollY = new Animated.Value(0);

jest.mock('@/context/LayoutScrollContext', () => ({
    useLayoutScroll: () => ({ scrollY: mockScrollY }),
}));

// The provider pins the bar visible on /videos by reading the pathname.
let mockPathname = '/';
jest.mock('expo-router', () => ({
    usePathname: () => mockPathname,
}));

// Reanimated's worklets runtime is not initialized under jest-expo. Mock the
// thin surface the provider uses: `useSharedValue` returns a plain mutable
// holder and `withTiming` resolves synchronously to its target so we can assert
// the resulting `.value` deterministically (the provider's auto-hide DECISION is
// what we verify, not the animation curve).
jest.mock('react-native-reanimated', () => ({
    useSharedValue: (initial: number) => ({ value: initial }),
    withTiming: (target: number) => target,
}));

function Capture({ onValue }: { onValue: (v: SharedValue<number>) => void }) {
    const hidden = useBottomBarHidden();
    onValue(hidden);
    return null;
}

function renderWithPath(path: string) {
    mockPathname = path;
    let hidden: SharedValue<number> | null = null;
    act(() => {
        TestRenderer.create(
            <BottomBarVisibilityProvider>
                <Capture onValue={(v) => { hidden = v; }} />
            </BottomBarVisibilityProvider>,
        );
    });
    return () => hidden as unknown as SharedValue<number>;
}

function pushScroll(value: number) {
    act(() => {
        mockScrollY.setValue(value);
    });
}

describe('BottomBarVisibilityProvider', () => {
    beforeEach(() => {
        mockScrollY.setValue(0);
    });

    it('hides the bar on downward scroll on a normal route', () => {
        const getHidden = renderWithPath('/');
        // Scroll past the activation offset, downward.
        pushScroll(100);
        pushScroll(300);
        expect(getHidden().value).toBeGreaterThan(0.5);
    });

    it('reveals the bar again on upward scroll on a normal route', () => {
        const getHidden = renderWithPath('/');
        pushScroll(300);
        pushScroll(100); // scroll up
        expect(getHidden().value).toBeLessThan(0.5);
    });

    it('keeps the bar pinned visible on /videos regardless of scroll', () => {
        const getHidden = renderWithPath('/videos');
        // Aggressive downward scroll that WOULD hide the bar on a normal route.
        pushScroll(100);
        pushScroll(800);
        pushScroll(1600);
        expect(getHidden().value).toBe(0);
    });
});
