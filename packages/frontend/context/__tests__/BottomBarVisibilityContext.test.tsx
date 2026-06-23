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
// the resulting settled `.value` deterministically (the provider's auto-hide
// DECISION + clean settle is what we verify, not the animation curve).
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
        mockPathname = '/';
    });

    it('hides the bar on downward scroll on a normal route', () => {
        const getHidden = renderWithPath('/');
        // Scroll past the activation offset, downward.
        pushScroll(100);
        pushScroll(300);
        expect(getHidden().value).toBe(1);
    });

    it('reveals the bar again on upward scroll on a normal route', () => {
        const getHidden = renderWithPath('/');
        pushScroll(300);
        pushScroll(100); // scroll up
        expect(getHidden().value).toBe(0);
    });

    it('keeps the bar pinned visible on /videos regardless of scroll', () => {
        const getHidden = renderWithPath('/videos');
        // Aggressive downward scroll that WOULD hide the bar on a normal route.
        pushScroll(100);
        pushScroll(800);
        pushScroll(1600);
        expect(getHidden().value).toBe(0);
    });

    // ── Regression: the bar must settle CLEANLY to 0 or 1, never an in-between
    // value (a partial translateY makes the fixed bar poke below the viewport).
    // This reproduces what happens on the profile screen, where the document
    // jumps to a non-zero scroll position via scroll-restoration / layout growth
    // BEFORE the user scrolls. The very first listener event therefore arrives
    // with a large positive delta measured against the closure's initial
    // lastKnownScrollY=0, which previously latched `isScrollingDown=true` and
    // hid the bar on entry (and, mid-restoration jitter, could leave it partway).

    it('does NOT treat the initial scroll-restoration jump as a downward scroll', () => {
        // Land on the profile already scrolled (restoration jumps 0 -> 600).
        const getHidden = renderWithPath('/@someone');
        pushScroll(600); // single restoration jump, no real user gesture
        // The bar must stay visible — a restoration jump is not a user scroll.
        expect(getHidden().value).toBe(0);
    });

    it('settles to a clean 0/1 (never partial) after a restoration jump then a small upward correction', () => {
        const getHidden = renderWithPath('/@someone');
        pushScroll(600); // restoration jump
        pushScroll(580); // tiny settle/correction upward
        const v = getHidden().value;
        expect(v === 0 || v === 1).toBe(true);
    });

    it('ignores a LATE programmatic restoration jump (after the baseline) — bar stays visible', () => {
        const getHidden = renderWithPath('/@someone');
        pushScroll(0);   // baseline at top
        pushScroll(20);  // tiny real settle (no hide yet, below activation)
        pushScroll(900); // late restoration jump — must NOT be read as a gesture
        expect(getHidden().value).toBe(0);
    });

    it('still hides on a fast-but-plausible downward fling (not suppressed as programmatic)', () => {
        const getHidden = renderWithPath('/');
        pushScroll(0);   // baseline
        pushScroll(150); // a fast single-frame fling, still a real gesture
        expect(getHidden().value).toBe(1);
    });
});
