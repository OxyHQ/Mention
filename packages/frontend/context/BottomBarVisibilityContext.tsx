import React, { createContext, useContext, useEffect } from 'react';
import { usePathname } from 'expo-router';
import { useSharedValue, withTiming, type SharedValue } from 'react-native-reanimated';

import { useLayoutScroll } from '@/context/LayoutScrollContext';

/**
 * Scroll distance (px) past which the auto-hide behaviour engages. Below this
 * the bar always stays visible (so a tiny scroll never hides it).
 */
const HIDE_ACTIVATION_OFFSET = 50;

/**
 * Minimum scroll delta (px) before we trust a direction change. Filters out
 * sub-pixel jitter from momentum / rubber-banding.
 */
const DIRECTION_DELTA_THRESHOLD = 1;

/**
 * Max plausible single-frame scroll delta (px) for a real user gesture. A jump
 * larger than this is a PROGRAMMATIC scroll (per-route scroll-restoration, a
 * deep-link offset, or layout growth shifting the document) — common on the
 * profile screen — and must NOT be read as a fast downward gesture that hides
 * the bar. Even an aggressive fling rarely moves this far in one ~16ms frame, so
 * the threshold suppresses restoration jumps without affecting genuine scrolls.
 * The jump still RE-BASELINES the position so the next real gesture is measured
 * from the landing offset.
 */
const PROGRAMMATIC_JUMP_THRESHOLD = 200;

/** Shared show/hide animation duration (ms). Bar and FAB stay in lock-step. */
export const BOTTOM_BAR_HIDE_DURATION = 200;

/**
 * Routes where the BottomBar must stay PERMANENTLY visible (no scroll auto-hide).
 * The immersive Reels viewer (`/videos`) floats the bar over fullscreen video
 * like TikTok/Reels — it must never slide away on scroll. The shared `hidden`
 * value is pinned to 0 while on these routes.
 */
const NO_AUTO_HIDE_ROUTES = new Set<string>(['/videos']);

const BottomBarVisibilityContext = createContext<SharedValue<number> | null>(null);

/**
 * Single source of truth for the bottom-bar auto-hide signal, shared across the
 * whole `(app)` group so the BottomBar, the floating action button and the
 * home/explore headers all read the SAME animated value (one scroll listener,
 * one timing) instead of each running an independent copy.
 *
 * `hidden` animates between:
 *   - `0` → bar fully visible
 *   - `1` → bar fully hidden (scrolled away)
 *
 * Driven by one listener on the shared `scrollY` (the global layout scroll
 * position). On the immersive Reels route the value is pinned to `0` so the bar
 * never auto-hides there (TikTok/Reels behaviour); everywhere else it hides on
 * downward scroll and reappears on upward scroll.
 *
 * The single `useEffect` here is the legitimate React pattern for subscribing to
 * an external mutable store (the Animated.Value), not a derived-state escape hatch.
 */
export function BottomBarVisibilityProvider({ children }: { children: React.ReactNode }) {
    const { scrollY } = useLayoutScroll();
    const pathname = usePathname();
    const hidden = useSharedValue(0);

    // Pin the bar visible on the no-auto-hide routes; otherwise let the scroll
    // listener drive `hidden`. Reading the pathname through the effect deps means
    // entering /videos snaps the bar back to visible immediately.
    const autoHideDisabled = NO_AUTO_HIDE_ROUTES.has(pathname);

    useEffect(() => {
        if (autoHideDisabled) {
            // Snap to visible and skip the scroll listener entirely on /videos.
            hidden.value = withTiming(0, { duration: BOTTOM_BAR_HIDE_DURATION });
            return;
        }

        let isScrollingDown = false;
        let lastKnownScrollY = 0;
        // The FIRST listener event after (re)attaching only CALIBRATES the
        // baseline — it never decides direction/hide. Otherwise a screen that
        // lands already scrolled (profile: scroll-restoration / layout growth
        // jumps the document from 0 to a large offset before any user gesture)
        // would be read as one giant "downward scroll" (delta = offset - 0) and
        // hide the bar on entry — and mid-restoration jitter could interrupt that
        // animation, leaving the bar parked at a partial translateY that pokes
        // below the viewport. Home starts at 0 so it never hit this; profile did.
        let hasBaseline = false;

        const listenerId = scrollY.addListener(({ value }) => {
            const currentScrollY = typeof value === 'number' ? value : 0;

            if (!hasBaseline) {
                hasBaseline = true;
                lastKnownScrollY = currentScrollY;
                return;
            }

            const scrollDelta = currentScrollY - lastKnownScrollY;

            // A jump too large for a single-frame gesture is programmatic
            // (restoration / deep-link / layout shift): re-baseline to the new
            // offset but do NOT change direction or `hidden`, so the bar never
            // hides (or sticks partway) from a non-gesture jump.
            if (Math.abs(scrollDelta) > PROGRAMMATIC_JUMP_THRESHOLD) {
                lastKnownScrollY = currentScrollY;
                return;
            }

            if (Math.abs(scrollDelta) > DIRECTION_DELTA_THRESHOLD) {
                isScrollingDown = scrollDelta > 0;
            }

            const shouldHide = currentScrollY > HIDE_ACTIVATION_OFFSET && isScrollingDown;
            hidden.value = withTiming(shouldHide ? 1 : 0, { duration: BOTTOM_BAR_HIDE_DURATION });

            lastKnownScrollY = currentScrollY;
        });

        return () => {
            scrollY.removeListener(listenerId);
        };
    }, [scrollY, hidden, autoHideDisabled]);

    return (
        <BottomBarVisibilityContext.Provider value={hidden}>
            {children}
        </BottomBarVisibilityContext.Provider>
    );
}

/**
 * Read the shared bottom-bar auto-hide signal. Consumers map `hidden` to their
 * own transform (e.g. bar `translateY: hidden * h` + `opacity: 1 - hidden`; FAB
 * `translateY: -(1 - hidden) * reservedSpace`) so a single timing keeps every
 * element in sync.
 */
export function useBottomBarHidden(): SharedValue<number> {
    const ctx = useContext(BottomBarVisibilityContext);
    if (!ctx) {
        throw new Error('useBottomBarHidden must be used within a BottomBarVisibilityProvider');
    }
    return ctx;
}
