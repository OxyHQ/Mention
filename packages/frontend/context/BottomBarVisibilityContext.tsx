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
 * Directional hysteresis: how many px of SUSTAINED same-direction scrolling must
 * accumulate before we COMMIT to a new direction (and therefore let the bar
 * start hiding/showing). Set to 40px — comfortably above realistic on-device
 * finger jitter (a held finger wobbles only a handful of px per event) yet below
 * the smallest intentional scroll gesture, so a genuine flick commits almost
 * immediately while a tiny up/down/up wobble never accumulates enough in EITHER
 * direction to flip the committed direction. The accumulator RESETS to the
 * current delta the instant the scroll sign reverses, so opposing wobble frames
 * cancel each other out instead of racing the hide/show animation back and forth
 * (the on-device "shake" this fixes). Kept below HIDE_ACTIVATION_OFFSET (50) so
 * it adds no perceptible lag before the bar reacts to a real scroll.
 */
const DIRECTION_COMMIT_THRESHOLD = 40;

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

/**
 * Current document scroll height (web) — used to tell a layout shift (the
 * virtualized feed measuring rows / images loading) apart from a real gesture.
 * Returns `0` off the web (native has no `document` and drives `scrollY` from
 * its own inner scroller, so the layout-growth guard is inert there).
 */
function readScrollHeight(): number {
    if (typeof document === 'undefined') return 0;
    return document.documentElement?.scrollHeight ?? 0;
}

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
        // Directional hysteresis accumulator (px). Sums consecutive
        // same-direction scroll deltas and RESETS to the current delta the
        // moment the scroll sign reverses. `isScrollingDown` only flips once the
        // accumulator crosses ±DIRECTION_COMMIT_THRESHOLD, so a small finger
        // wobble (alternating +/- deltas) keeps cancelling itself out and never
        // commits a direction change → no oscillation.
        let directionAccumulator = 0;
        // Last target we actually animated `hidden` toward (0 = shown, 1 =
        // hidden). We only (re)start the timing when the target genuinely
        // changes, so a stream of same-direction scroll events never restarts
        // the animation every frame — that per-event restart, combined with a
        // flip-flopping direction, produced the visible mid-animation shake.
        // Re-declared per effect run, so re-attaching the listener (e.g. leaving
        // /videos) starts these trackers clean with the bar visible.
        let currentTarget = 0;
        // The FIRST listener event after (re)attaching only CALIBRATES the
        // baseline — it never decides direction/hide. Otherwise a screen that
        // lands already scrolled (profile: scroll-restoration / layout growth
        // jumps the document from 0 to a large offset before any user gesture)
        // would be read as one giant "downward scroll" (delta = offset - 0) and
        // hide the bar on entry — and mid-restoration jitter could interrupt that
        // animation, leaving the bar parked at a partial translateY that pokes
        // below the viewport. Home starts at 0 so it never hit this; profile did.
        let hasBaseline = false;
        // Web layout-growth tracker: explore/profile feeds virtualize rows and
        // load images AFTER mount, so `document.scrollHeight` grows for seconds
        // and the document re-settles `scrollY` in small (<threshold) steps. Each
        // such step is a LAYOUT shift, not a gesture — detected by the document
        // height changing since the previous event. Seeded to the current height
        // so the first real event compares against the right baseline.
        let lastScrollHeight = readScrollHeight();

        const listenerId = scrollY.addListener(({ value }) => {
            const currentScrollY = typeof value === 'number' ? value : 0;

            if (!hasBaseline) {
                hasBaseline = true;
                lastKnownScrollY = currentScrollY;
                lastScrollHeight = readScrollHeight();
                // Start the direction trackers clean from the calibrated
                // baseline (the bar is visible on entry → target 0) so the first
                // real gesture is measured from a known-good origin and never
                // resumes a stale mid-flip from a previous screen.
                directionAccumulator = 0;
                isScrollingDown = false;
                currentTarget = 0;
                return;
            }

            // Layout-growth guard (web): if the document height changed since the
            // last event, this `scrollY` delta is the document re-settling under
            // the viewport (virtualized rows measuring, images loading), NOT a
            // user gesture. Re-baseline both trackers and leave `hidden` alone so
            // gradual growth never hides (or half-hides) the bar. Catches the
            // small-step reflows the magnitude guard below lets through.
            const currentScrollHeight = readScrollHeight();
            if (currentScrollHeight !== lastScrollHeight) {
                lastScrollHeight = currentScrollHeight;
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

            // Directional hysteresis. Sub-pixel noise is ignored outright (it
            // never touches the accumulator). Otherwise accumulate same-direction
            // motion; if this delta's sign is opposite to the accumulated
            // direction, RESTART the accumulator at this delta so opposing wobble
            // frames cancel instead of compounding. A direction change only
            // COMMITS once the accumulator crosses the commit threshold — this is
            // what rejects a few-px up/down/up wobble that would otherwise flip
            // direction on every event and shake the bar.
            if (Math.abs(scrollDelta) > DIRECTION_DELTA_THRESHOLD) {
                const reversed =
                    (scrollDelta > 0 && directionAccumulator < 0) ||
                    (scrollDelta < 0 && directionAccumulator > 0);
                directionAccumulator = reversed ? scrollDelta : directionAccumulator + scrollDelta;

                if (directionAccumulator >= DIRECTION_COMMIT_THRESHOLD) {
                    isScrollingDown = true;
                } else if (directionAccumulator <= -DIRECTION_COMMIT_THRESHOLD) {
                    isScrollingDown = false;
                }
            }

            // Only (re)start the timing when the committed target actually
            // changes, so a sustained scroll in one direction animates ONCE
            // instead of restarting the animation on every scroll event.
            const shouldHide = currentScrollY > HIDE_ACTIVATION_OFFSET && isScrollingDown;
            const target = shouldHide ? 1 : 0;
            if (target !== currentTarget) {
                currentTarget = target;
                hidden.value = withTiming(target, { duration: BOTTOM_BAR_HIDE_DURATION });
            }

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
