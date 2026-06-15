import { useEffect } from 'react';
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

/** Shared show/hide animation duration (ms). Bar and FAB stay in lock-step. */
export const BOTTOM_BAR_HIDE_DURATION = 200;

/**
 * Single source of truth for the bottom-bar auto-hide signal.
 *
 * Returns a reanimated shared value `hidden` that animates between:
 *   - `0` → bar fully visible
 *   - `1` → bar fully hidden (scrolled away)
 *
 * Driven by one listener on the shared `scrollY` (the global layout scroll
 * position). Both the bottom bar AND the floating action button consume this so
 * they slide away together instead of each running their own scroll listener.
 * Consumers map `hidden` to their own transform (e.g. `translateY: hidden * h`,
 * `opacity: 1 - hidden`) so a single timing keeps every element in sync.
 *
 * The single `useEffect` here is the legitimate React pattern for subscribing to
 * an external mutable store (the Animated.Value), not a derived-state escape hatch.
 */
export function useBottomBarVisibility(): SharedValue<number> {
    const { scrollY } = useLayoutScroll();
    const hidden = useSharedValue(0);

    useEffect(() => {
        let isScrollingDown = false;
        let lastKnownScrollY = 0;

        const listenerId = scrollY.addListener(({ value }) => {
            const currentScrollY = typeof value === 'number' ? value : 0;
            const scrollDelta = currentScrollY - lastKnownScrollY;

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
    }, [scrollY, hidden]);

    return hidden;
}
