import React, { createContext, useContext, useEffect } from 'react';
import { usePathname } from 'expo-router';
import { useAnimatedReaction, useSharedValue, type SharedValue } from 'react-native-reanimated';

import { useLayoutScroll } from '@/context/LayoutScrollContext';

/**
 * Scroll distance (px) over which the chrome travels from fully shown (0) to
 * fully hidden (1). `hideAmount` is the CLAMPED running sum of scroll delta over
 * this range and `hidden` is just that normalized, so the chrome tracks the
 * finger 1:1 within the range and can never overshoot. ~90px ≈ the chrome's own
 * travel, so a deliberate scroll hides it within a short gesture while a small
 * finger wobble only nudges it a few px (and clamps).
 */
const HIDE_SCROLL_RANGE = 90;

/**
 * Scroll offset (px) below which the chrome is pinned fully shown. Keeps the
 * header from partially hiding on a tiny scroll right at the top and guarantees a
 * clean fully-shown state whenever the user returns to the top.
 */
const HIDE_ACTIVATION_OFFSET = 50;

/**
 * Max plausible single-frame scroll delta (px) for a real gesture. A larger jump
 * is programmatic — scroll restoration, a deep-link offset, or the focused
 * scroller switching on navigation — and must not be integrated as a hide/reveal
 * gesture. It re-baselines only (the next real delta is measured from the landing
 * offset). Even an aggressive fling rarely moves this far in one ~16ms frame.
 */
const PROGRAMMATIC_JUMP_THRESHOLD = 200;

/**
 * Routes where the chrome must stay PERMANENTLY visible (no scroll auto-hide).
 * The immersive Reels viewer (`/videos`) floats the bar over fullscreen video
 * like TikTok/Reels — it must never slide away on scroll. `hidden` is pinned to 0
 * while on these routes.
 */
const NO_AUTO_HIDE_ROUTES = new Set<string>(['/videos']);

const BottomBarVisibilityContext = createContext<SharedValue<number> | null>(null);

/**
 * Single source of truth for the chrome auto-hide signal, shared across the whole
 * `(app)` group so the BottomBar, the floating action button and the home/explore
 * headers all read the SAME animated value (one driver, one shared value) instead
 * of each running an independent copy.
 *
 * `hidden` is CONTINUOUS in [0, 1]:
 *   - `0` → chrome fully visible
 *   - `1` → chrome fully hidden (scrolled away)
 *
 * ARCHITECTURE — continuous, UI-thread, scroll-driven translate (diffClamp).
 * The driver is a `useAnimatedReaction` worklet on the shared `scrollPosition`
 * (fed by every scroller through `setScrollY`). On each frame it integrates the
 * scroll delta into a CLAMPED `hideAmount` and normalizes it to `hidden`:
 *
 *     dy = y - prevY
 *     hideAmount = clamp(hideAmount + dy, 0, HIDE_SCROLL_RANGE)
 *     hidden     = hideAmount / HIDE_SCROLL_RANGE
 *
 * Scrolling down slides the chrome away proportionally; scrolling up reveals it
 * proportionally; a tiny finger wobble just nudges it a few px and clamps.
 * Because the value is continuous — no bistable direction flag, no `withTiming`
 * target to flip, no animation to restart — it is STRUCTURALLY incapable of the
 * oscillation the old direction-toggle produced. The whole thing runs on the UI
 * thread, so there is no JS-thread listener and no dropped-frame jitter.
 *
 * The reflow feedback the old design fought with hysteresis/locks is removed at
 * the source: the home/explore screens no longer animate an in-flow spacer — the
 * chrome is an absolute overlay that only translates and the feed carries a fixed
 * top inset — so hiding the chrome never reflows the scrollable content.
 */
export function BottomBarVisibilityProvider({ children }: { children: React.ReactNode }) {
    const { scrollPosition } = useLayoutScroll();
    const pathname = usePathname();

    // The shared auto-hide signal consumers read (0 = shown, 1 = hidden).
    const hidden = useSharedValue(0);
    // Clamped running sum of scroll delta in [0, HIDE_SCROLL_RANGE]. `hidden` is
    // this normalized. Kept as its own value (NOT derived from a direction flag)
    // is the whole point: it is continuous, so it can never flip-flop.
    const hideAmount = useSharedValue(0);

    // Pin the chrome visible on the no-auto-hide routes; elsewhere the reaction
    // drives `hidden` from scroll.
    const autoHideDisabled = NO_AUTO_HIDE_ROUTES.has(pathname);

    // Reset to fully shown on every route change (and when entering/leaving a
    // pinned route). Each screen should start with the chrome visible; the
    // reaction then drives it from that screen's own scrolling. Because the reaction
    // only fires on a scroll change, this also guarantees the pinned routes show
    // the chrome even without any scroll.
    useEffect(() => {
        hideAmount.value = 0;
        hidden.value = 0;
    }, [pathname, hidden, hideAmount]);

    // THE DRIVER. A UI-thread worklet that integrates a clamped hide amount from
    // the shared scroll position. `useAnimatedReaction` hands us (current,
    // previous), so the delta is always measured against the last reacted frame —
    // robust to reanimated coalescing rapid updates, and immune to a stale
    // manually-tracked `lastY` desyncing.
    useAnimatedReaction(
        () => scrollPosition.value,
        (y, prevY) => {
            'worklet';
            if (autoHideDisabled) {
                hideAmount.value = 0;
                hidden.value = 0;
                return;
            }
            const previous = prevY ?? y;
            const dy = y - previous;
            // Ignore non-gesture jumps (restoration / focused-scroller switch on
            // navigation): leave the hide amount untouched and re-baseline, so a
            // programmatic offset change never hides (or half-hides) the chrome.
            if (dy > PROGRAMMATIC_JUMP_THRESHOLD || dy < -PROGRAMMATIC_JUMP_THRESHOLD) {
                return;
            }
            let next: number;
            if (y <= HIDE_ACTIVATION_OFFSET) {
                // Near the top: always fully shown.
                next = 0;
            } else {
                next = hideAmount.value + dy;
                if (next < 0) next = 0;
                else if (next > HIDE_SCROLL_RANGE) next = HIDE_SCROLL_RANGE;
            }
            hideAmount.value = next;
            hidden.value = next / HIDE_SCROLL_RANGE;
        },
        [autoHideDisabled],
    );

    return (
        <BottomBarVisibilityContext.Provider value={hidden}>
            {children}
        </BottomBarVisibilityContext.Provider>
    );
}

/**
 * Read the shared chrome auto-hide signal. Consumers map `hidden` to their own
 * transform (e.g. bar `translateY: hidden * travel` + `opacity: 1 - hidden`; FAB
 * `translateY: -(1 - hidden) * reservedSpace`; header `translateY: hidden *
 * -(headerHeight + insets.top)`) so a single continuous value keeps every element
 * in lock-step.
 */
export function useBottomBarHidden(): SharedValue<number> {
    const ctx = useContext(BottomBarVisibilityContext);
    if (!ctx) {
        throw new Error('useBottomBarHidden must be used within a BottomBarVisibilityProvider');
    }
    return ctx;
}
