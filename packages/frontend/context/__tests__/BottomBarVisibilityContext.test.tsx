import React from 'react';
import { Animated } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import { withTiming, type SharedValue } from 'react-native-reanimated';

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
// DECISION + clean settle is what we verify, not the animation curve). It is a
// `jest.fn` so the anti-jitter tests can also assert HOW MANY times the
// animation is (re)started — a wobble must NOT restart it.
jest.mock('react-native-reanimated', () => ({
    useSharedValue: (initial: number) => ({ value: initial }),
    withTiming: jest.fn((target: number) => target),
}));

function Capture({ onValue }: { onValue: (v: SharedValue<number>) => void }) {
    const hidden = useBottomBarHidden();
    onValue(hidden);
    return null;
}

// Track every renderer so afterEach can unmount them. Each provider attaches a
// listener to the module-level `mockScrollY`; without unmount a leaked listener
// from a previous test would keep firing (and calling the shared `withTiming`
// mock) on the next test's `pushScroll`, corrupting the call counts the
// anti-jitter tests assert on.
const renderers: TestRenderer.ReactTestRenderer[] = [];

function renderWithPath(path: string) {
    mockPathname = path;
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

function pushScroll(value: number) {
    act(() => {
        mockScrollY.setValue(value);
    });
}

// Web layout-growth simulation: the provider reads
// `document.documentElement.scrollHeight` to distinguish a gesture from a
// document that grew/shifted under the viewport. The jest-expo (native preset)
// environment has no real `document`, so we install a minimal stub whose
// scrollHeight we control per step.
const documentStub = { documentElement: { scrollHeight: 2000 } };
function setScrollHeight(h: number) {
    documentStub.documentElement.scrollHeight = h;
}

beforeAll(() => {
    (globalThis as { document?: unknown }).document = documentStub;
});
afterAll(() => {
    delete (globalThis as { document?: unknown }).document;
});

describe('BottomBarVisibilityProvider', () => {
    beforeEach(() => {
        mockScrollY.setValue(0);
        mockPathname = '/';
        setScrollHeight(2000);
        // Reset the withTiming call log so the anti-jitter tests can count how
        // many times the animation is (re)started. Clears calls only, keeps the
        // `(target) => target` implementation the value-assertion tests rely on.
        jest.mocked(withTiming).mockClear();
    });

    afterEach(() => {
        // Unmount so each provider's scroll listener is detached; otherwise a
        // leaked listener keeps driving the shared withTiming mock on later tests.
        act(() => {
            renderers.forEach((r) => r.unmount());
        });
        renderers.length = 0;
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

    // ── Regression: GRADUAL layout growth (explore / profile). The virtualized
    // feed measures rows + images load AFTER mount, so `document.scrollHeight`
    // grows over time and the document re-settles `scrollY` in SMALL steps
    // (<200px/frame) for seconds. Each step passed the magnitude guard and was
    // read as a "downward gesture" → the bar misfired/stuck partway → it poked
    // below the viewport. Each of these steps is accompanied by a scrollHeight
    // CHANGE, which the fix uses to classify them as layout, not gesture.
    it('does NOT hide on gradual layout-growth steps (scrollHeight changing each step)', () => {
        const getHidden = renderWithPath('/explore');
        setScrollHeight(2000);
        pushScroll(0); // baseline at top
        // Document grows in small steps; each <200px but scrollHeight changes.
        setScrollHeight(2400); pushScroll(60);
        setScrollHeight(2900); pushScroll(130);
        setScrollHeight(3500); pushScroll(190);
        setScrollHeight(4200); pushScroll(250);
        // No real user gesture happened — the bar must stay fully visible.
        expect(getHidden().value).toBe(0);
    });

    it('still hides on a real gesture AFTER layout growth settles (scrollHeight stable)', () => {
        const getHidden = renderWithPath('/explore');
        setScrollHeight(2000);
        pushScroll(0);
        // Growth phase (scrollHeight changing) — ignored.
        setScrollHeight(3000); pushScroll(120);
        setScrollHeight(4000); pushScroll(200);
        // Layout settled: scrollHeight stable, now a genuine downward gesture.
        pushScroll(260); // delta +60, same scrollHeight → real scroll
        pushScroll(330); // continue down
        expect(getHidden().value).toBe(1);
    });

    it('still hides during a real downward gesture even with intermittent infinite-scroll growth', () => {
        // A genuine continuous downward scroll where a new page loads partway
        // (scrollHeight bumps once). The frames with stable scrollHeight still
        // register the downward gesture, so the bar hides.
        const getHidden = renderWithPath('/explore');
        setScrollHeight(4000);
        pushScroll(0);        // baseline
        pushScroll(80);       // gesture, stable height → down
        pushScroll(160);      // gesture, stable height → down
        setScrollHeight(6000); pushScroll(230); // a page loads (height bump) → ignored
        pushScroll(300);      // gesture resumes, stable height → down
        pushScroll(380);      // down
        expect(getHidden().value).toBe(1);
    });

    // ── Anti-jitter (on-device shake). The bug: a held finger wobbling a few px
    // up/down produced alternating +/- deltas that each flipped the direction and
    // restarted an opposing hide/show animation EVERY event → the header + bottom
    // bar shook infinitely mid-transition. The fix is directional hysteresis (an
    // accumulator that only commits a direction change past DIRECTION_COMMIT_
    // THRESHOLD and resets on sign reversal) plus a target-change guard (the
    // timing only (re)starts when the committed 0/1 target actually changes).

    it('does NOT flip or animate on a small finger wobble below the commit threshold', () => {
        const getHidden = renderWithPath('/');
        pushScroll(200); // baseline calibration (no decision) — already past offset
        jest.mocked(withTiming).mockClear();
        // Held finger: a few px each way. Each frame is far below the commit
        // threshold AND the accumulator resets on every sign reversal, so the
        // committed direction never flips → the bar stays visible.
        pushScroll(206);
        pushScroll(200);
        pushScroll(206);
        pushScroll(200);
        pushScroll(206);
        pushScroll(200);
        expect(getHidden().value).toBe(0);
        // The committed target never changed, so the animation was never started.
        expect(jest.mocked(withTiming)).not.toHaveBeenCalled();
    });

    it('does NOT re-trigger the hide/show animation on a wobble AFTER a sustained scroll (anti-shake)', () => {
        const getHidden = renderWithPath('/');
        pushScroll(0);   // baseline
        pushScroll(120); // sustained down past the activation offset → hides (1 animation)
        expect(getHidden().value).toBe(1);
        jest.mocked(withTiming).mockClear();
        // Now the user holds and wobbles. In the buggy version each event
        // restarted an opposing animation → the visible shake. It must stay
        // hidden and NOT restart the timing at all.
        pushScroll(126);
        pushScroll(120);
        pushScroll(126);
        pushScroll(120);
        expect(getHidden().value).toBe(1);
        expect(jest.mocked(withTiming)).not.toHaveBeenCalled();
    });

    it('hides on a sustained downward scroll with exactly one animation start', () => {
        const getHidden = renderWithPath('/');
        pushScroll(0);   // baseline
        jest.mocked(withTiming).mockClear();
        // Sustained downward motion in steps that each stay under the programmatic
        // jump threshold; cumulatively well past the commit threshold.
        pushScroll(60);  // +60 → commits down, past activation offset → hide
        pushScroll(120); // continue down — same target, must NOT restart animation
        pushScroll(180); // continue down — same target
        expect(getHidden().value).toBe(1);
        expect(jest.mocked(withTiming)).toHaveBeenCalledTimes(1);
        expect(jest.mocked(withTiming)).toHaveBeenCalledWith(1, expect.anything());
    });

    it('reveals on a sustained upward scroll after hiding, with exactly one animation start', () => {
        const getHidden = renderWithPath('/');
        pushScroll(0);   // baseline
        pushScroll(150); // sustained down → hide
        expect(getHidden().value).toBe(1);
        jest.mocked(withTiming).mockClear();
        // Sustained upward motion of 60px (> commit threshold) → commit up → reveal.
        pushScroll(90);
        expect(getHidden().value).toBe(0);
        expect(jest.mocked(withTiming)).toHaveBeenCalledTimes(1);
        expect(jest.mocked(withTiming)).toHaveBeenCalledWith(0, expect.anything());
    });
});
