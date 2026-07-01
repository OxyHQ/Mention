import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { type SharedValue } from 'react-native-reanimated';

import {
    BottomBarVisibilityProvider,
    useBottomBarHidden,
} from '@/context/BottomBarVisibilityContext';

// ── The new driver is a CONTINUOUS diffClamp integrator (no bistable toggle, no
// timing animation). It reads the shared reanimated `scrollPosition` via a
// `useAnimatedReaction` worklet and integrates a clamped hide amount:
//     dy = y - prevY; hideAmount = clamp(hideAmount + dy, 0, RANGE); hidden = hideAmount/RANGE
// These tests assert that math end-to-end: a sustained scroll fully hides, an
// upward scroll reveals, a small finger wobble only nudges `hidden` a few percent
// and NEVER snaps to 0/1 or oscillates, /videos stays pinned visible, and a
// programmatic jump is ignored.

// The provider consumes `scrollPosition` from LayoutScrollContext — mock it as a
// plain mutable holder we can drive directly.
const mockScrollPosition = { value: 0 };

jest.mock('@/context/LayoutScrollContext', () => ({
    useLayoutScroll: () => ({ scrollPosition: mockScrollPosition }),
}));

// The provider pins the chrome visible on /videos by reading the pathname.
let mockPathname = '/';
jest.mock('expo-router', () => ({
    usePathname: () => mockPathname,
}));

// Reanimated's worklet runtime is not initialized under jest-expo. Mock the thin
// surface the provider uses: `useSharedValue` returns a plain mutable holder and
// `useAnimatedReaction` captures its (prepare, react) pair so a test can drive the
// worklet deterministically by pushing scroll values through it. The worklet body
// is a plain function under jest, so calling it runs the real clamp logic.
const mockReaction: {
    current: null | { prepare: () => number; react: (current: number, previous: number | null) => void };
} = { current: null };

jest.mock('react-native-reanimated', () => ({
    useSharedValue: (initial: number) => ({ value: initial }),
    useAnimatedReaction: (
        prepare: () => number,
        react: (current: number, previous: number | null) => void,
    ) => {
        mockReaction.current = { prepare, react };
    },
}));

function Capture({ onValue }: { onValue: (v: SharedValue<number>) => void }) {
    const hidden = useBottomBarHidden();
    onValue(hidden);
    return null;
}

const renderers: TestRenderer.ReactTestRenderer[] = [];

// The reaction is handed (current, previous) each tick; track the previous
// reacted value here (starts null on entry, exactly like reanimated's first call).
let prevReacted: number | null = null;

function renderWithPath(path: string) {
    mockPathname = path;
    prevReacted = null;
    let hidden: SharedValue<number> | null = null;
    let renderer: TestRenderer.ReactTestRenderer | null = null;
    act(() => {
        renderer = TestRenderer.create(
            <BottomBarVisibilityProvider>
                <Capture onValue={(v) => { hidden = v; }} />
            </BottomBarVisibilityProvider>,
        );
    });
    if (renderer) renderers.push(renderer);
    return () => hidden as unknown as SharedValue<number>;
}

// Drive one scroll frame: set the shared position and run the captured worklet
// with (current, previous), mirroring reanimated's useAnimatedReaction contract.
function pushScroll(y: number) {
    act(() => {
        mockScrollPosition.value = y;
        const r = mockReaction.current;
        if (r) {
            const current = r.prepare();
            r.react(current, prevReacted);
            prevReacted = current;
        }
    });
}

describe('BottomBarVisibilityProvider (continuous diffClamp)', () => {
    beforeEach(() => {
        mockScrollPosition.value = 0;
        mockReaction.current = null;
        mockPathname = '/';
        prevReacted = null;
    });

    afterEach(() => {
        act(() => {
            renderers.forEach((r) => r.unmount());
        });
        renderers.length = 0;
    });

    it('fully hides the chrome on a sustained downward scroll', () => {
        const getHidden = renderWithPath('/');
        pushScroll(0);   // baseline (first frame calibrates: dy = 0)
        pushScroll(60);  // past the 50px activation → begins hiding
        pushScroll(120); // keep scrolling down
        pushScroll(200); // well past the hide range → fully hidden
        expect(getHidden().value).toBe(1);
    });

    it('reveals the chrome proportionally on an upward scroll after hiding', () => {
        const getHidden = renderWithPath('/');
        pushScroll(0);
        pushScroll(200); // fully hidden
        expect(getHidden().value).toBe(1);
        // Scroll up 45px → hide amount drops by 45 of the 90px range → half shown.
        pushScroll(155);
        expect(getHidden().value).toBeCloseTo(0.5, 5);
        // Continue up past the activation offset → fully shown again.
        pushScroll(40);
        expect(getHidden().value).toBe(0);
    });

    it('maps scroll position proportionally within the hide range (continuous, not bistable)', () => {
        const getHidden = renderWithPath('/');
        pushScroll(0);
        pushScroll(50); // exactly at the activation offset → still fully shown
        expect(getHidden().value).toBe(0);
        pushScroll(95); // 45px past activation of a 90px range → half hidden
        expect(getHidden().value).toBeCloseTo(0.5, 5);
    });

    it('only nudges `hidden` a few percent on a finger wobble — never snaps to 0/1 or oscillates', () => {
        const getHidden = renderWithPath('/');
        pushScroll(0);
        pushScroll(60); // settle at a partially-hidden state (~0.67)
        const settled = getHidden().value;
        expect(settled).toBeGreaterThan(0);
        expect(settled).toBeLessThan(1);

        // A held finger wobbling a few px each way. Each frame moves `hidden` only
        // by delta/RANGE, and the value simply tracks — it can never flip a target
        // or restart an animation, so it stays bounded around the settled value and
        // never reaches the 0 or 1 extremes.
        const wobble = [66, 58, 64, 57, 63, 59];
        const seen: number[] = [];
        for (const y of wobble) {
            pushScroll(y);
            seen.push(getHidden().value);
        }
        for (const v of seen) {
            expect(v).toBeGreaterThan(0);
            expect(v).toBeLessThan(1);
            // Each wobble frame stays within a small band of the settled value
            // (the largest single step is 9px = 0.1 of the range).
            expect(Math.abs(v - settled)).toBeLessThan(0.15);
        }
    });

    it('keeps the chrome pinned visible on /videos regardless of scroll', () => {
        const getHidden = renderWithPath('/videos');
        pushScroll(0);
        pushScroll(200);
        pushScroll(600);
        expect(getHidden().value).toBe(0);
    });

    it('ignores a programmatic jump (restoration / navigation) — does not hide on a huge single-frame delta', () => {
        const getHidden = renderWithPath('/@someone');
        pushScroll(0);   // baseline
        pushScroll(600); // single 600px jump in one frame → treated as non-gesture
        expect(getHidden().value).toBe(0);
    });

    it('stays fully shown near the top (activation gate)', () => {
        const getHidden = renderWithPath('/');
        pushScroll(0);
        pushScroll(20);
        pushScroll(45); // still within the 50px activation offset
        expect(getHidden().value).toBe(0);
    });

    it('still hides on a fast-but-plausible downward fling (not suppressed as programmatic)', () => {
        const getHidden = renderWithPath('/');
        pushScroll(0);
        pushScroll(150); // 150px in one frame is a real fling (< 200px jump guard)
        expect(getHidden().value).toBe(1);
    });
});
