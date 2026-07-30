import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef } from 'react';
import { Animated, Platform } from 'react-native';
import { useSharedValue, type SharedValue } from 'react-native-reanimated';

const IS_WEB = Platform.OS === 'web';

/**
 * The scroll metrics every scroller reports, whichever platform produced them.
 * Native delivers them under `nativeEvent`; react-native-web sometimes reports
 * the offset as `scrollTop` on the target DOM node instead, and `target` is a
 * numeric node handle rather than a node on native — hence the unions.
 */
type ScrollMetrics = {
    contentOffset?: { x?: number; y?: number } | number;
    contentSize?: { height?: number; width?: number };
    layoutMeasurement?: { height?: number; width?: number };
    target?: { scrollTop?: number } | number;
};

/**
 * A scroll event as this app consumes it. The metrics are readable at the top
 * level too, so a caller may hand over a bare `nativeEvent` payload.
 */
export type ScrollEvent = ScrollMetrics & {
    nativeEvent?: ScrollMetrics;
};

/** Anything this app can drive to an offset — a FlashList, a ScrollView, a FlatList. */
export type ScrollableRef = {
    scrollToOffset?: (params: { offset: number; animated?: boolean }) => void;
    scrollTo?: (params: { x?: number; y?: number; animated?: boolean }) => void;
};

/**
 * What a ref callback is actually handed. `Animated.ScrollView` still types its
 * ref as possibly the legacy `getNode()` wrapper, so a callback that registers a
 * scroller has to unwrap before it gets a {@link ScrollableRef}.
 */
export type ScrollableRefTarget = ScrollableRef | { getNode(): ScrollableRef };

type LayoutScrollContextValue = {
    scrollY: Animated.Value;
    /**
     * Reanimated mirror of the global scroll offset, updated in lock-step with
     * `scrollY` through the shared `setScrollY` chokepoint. Every scroller already
     * routes its offset here, so this ONE shared value is the single UI-thread
     * input for scroll-driven worklets (the auto-hide `hidden` signal reads it via
     * `useAnimatedReaction`). Reanimated worklets cannot read the legacy
     * `Animated.Value` on the UI thread, which is why this parallel value exists;
     * `scrollY` stays for the old-`Animated` interpolations (profile banner/name
     * fade) and the imperative infinite-scroll listeners.
     */
    scrollPosition: SharedValue<number>;
    scrollEventThrottle: number;
    /**
     * Imperatively update the shared scrollY based on a synthetic scroll event.
     * Provides a fallback for components that cannot use Animated.event (e.g. the web document scroller)
     */
    handleScroll: (event: ScrollEvent) => void;
    /**
     * Factory that returns an Animated.event handler bound to the shared scrollY.
     * Consumers can provide an optional listener to run side effects alongside the shared update.
     */
    createAnimatedScrollHandler: (listener?: (event: ScrollEvent) => void) => (event: ScrollEvent) => void;
    /**
     * Direct setter for components that need to programmatically adjust the global scroll position.
     */
    setScrollY: (value: number) => void;
    /**
     * Register the component that should respond to global wheel/scroll gestures (web only).
     */
    registerScrollable: (ref: ScrollableRef | null) => () => void;
    /**
     * Scroll the registered scrollable back to the top.
     */
    scrollToTop: () => void;
    /**
     * Scroll the registered native owner (or the web document) to an offset.
     */
    scrollToOffset: (offset: number, animated?: boolean) => void;
};

const LayoutScrollContext = createContext<LayoutScrollContextValue | null>(null);

interface LayoutScrollProviderProps {
    children: React.ReactNode;
    scrollEventThrottle?: number;
}

export function extractOffsetY(event: ScrollEvent): number {
    const nativeEvent = event?.nativeEvent ?? event;
    if (!nativeEvent) return 0;

    const contentOffset = nativeEvent.contentOffset;
    if (typeof contentOffset === 'number') return contentOffset;

    const offsetY = contentOffset?.y;
    if (typeof offsetY === 'number') return offsetY;

    // React Native Web sometimes keeps scrollTop on the target node instead.
    const target = nativeEvent.target ?? event?.target;
    if (typeof target === 'object' && target !== null && typeof target.scrollTop === 'number') {
        return target.scrollTop;
    }

    return 0;
}

export function LayoutScrollProvider({
    children,
    scrollEventThrottle = 16,
}: LayoutScrollProviderProps) {
    const scrollY = useRef(new Animated.Value(0)).current;
    const scrollPosition = useSharedValue(0);
    const scrollableRef = useRef<ScrollableRef | null>(null);
    const scrollPositionRef = useRef(0);
    const activeRegistrationId = useRef<number | null>(null);
    const registrationCounter = useRef(0);

    const setScrollY = useCallback((value: number) => {
        scrollY.setValue(value);
        // Mirror into the reanimated shared value so UI-thread worklets (auto-hide)
        // see every scroller's offset through the one chokepoint.
        scrollPosition.value = value;
        scrollPositionRef.current = value;
    }, [scrollY, scrollPosition]);

    // WEB document-scroll model: the BODY is the scroller (no inner feed
    // ScrollView), so a single window 'scroll' listener here is the source of
    // truth for the shared scrollY. This replaces the per-feed onScroll →
    // handleScroll path on web and keeps every consumer (BottomBar auto-hide,
    // HomeScreen header/FAB) working unchanged. Subscribing to an external
    // mutable store (window scroll) is a legitimate useEffect — same
    // justification as the BottomBarVisibility listener. No-op on native, which
    // still drives scrollY through its inner FlashList via handleScroll.
    useEffect(() => {
        if (!IS_WEB || typeof window === 'undefined') return;
        const onWindowScroll = () => {
            setScrollY(window.scrollY || window.pageYOffset || 0);
        };
        // Prime once so a restored offset (or a non-zero cold-boot position) is
        // reflected immediately rather than on the first user scroll.
        onWindowScroll();
        window.addEventListener('scroll', onWindowScroll, { passive: true });
        return () => {
            window.removeEventListener('scroll', onWindowScroll);
        };
    }, [setScrollY]);

    const handleScroll = useCallback((event: ScrollEvent) => {
        const offset = extractOffsetY(event);
        setScrollY(offset);
    }, [setScrollY]);

    const createAnimatedScrollHandler = useCallback(
        (listener?: (event: ScrollEvent) => void) => {
            // Throttle listener calls to reduce overhead
            let lastCallTime = 0;
            const THROTTLE_MS = 16; // ~60fps
            
            return Animated.event<ScrollMetrics>(
                [{ nativeEvent: { contentOffset: { y: scrollY } } }],
                {
                    useNativeDriver: false, // Required for scroll position
                    listener: (event) => {
                        const now = Date.now();
                        // Always update scrollY state (required for animations)
                        handleScroll(event);
                        
                        // Throttle custom listener calls to reduce overhead
                        if (listener) {
                            if (now - lastCallTime >= THROTTLE_MS) {
                                lastCallTime = now;
                                listener(event);
                            }
                        }
                    },
                }
            );
        },
        [handleScroll, scrollY]
    );

    const registerScrollable = useCallback((ref: ScrollableRef | null) => {
        // WEB: the document scrolls, so there is no inner scrollable to register
        // for wheel forwarding. Keep the same signature (consumers call it and
        // store the returned cleanup) but make it inert on web.
        if (IS_WEB) {
            return () => {};
        }
        const id = ++registrationCounter.current;
        activeRegistrationId.current = id;
        scrollableRef.current = ref;
        return () => {
            if (activeRegistrationId.current === id) {
                scrollableRef.current = null;
                activeRegistrationId.current = null;
            }
        };
    }, []);

    const scrollToOffset = useCallback((offset: number, animated = true) => {
        const boundedOffset = Math.max(0, offset);
        // WEB: scroll the document — the body is the scroller.
        if (IS_WEB) {
            if (typeof window !== 'undefined') {
                window.scrollTo({
                    top: boundedOffset,
                    behavior: animated ? 'smooth' : 'auto',
                });
            }
            return;
        }
        const scroller = scrollableRef.current;
        if (!scroller) return;
        if (typeof scroller.scrollToOffset === 'function') {
            scroller.scrollToOffset({ offset: boundedOffset, animated });
        } else if (typeof scroller.scrollTo === 'function') {
            scroller.scrollTo({ y: boundedOffset, animated });
        }
    }, []);

    const scrollToTop = useCallback(() => {
        scrollToOffset(0);
    }, [scrollToOffset]);

    const value = useMemo<LayoutScrollContextValue>(() => ({
        scrollY,
        scrollPosition,
        scrollEventThrottle: Math.max(16, scrollEventThrottle),
        handleScroll,
        createAnimatedScrollHandler,
        setScrollY,
        registerScrollable,
        scrollToTop,
        scrollToOffset,
    }), [createAnimatedScrollHandler, handleScroll, registerScrollable, scrollEventThrottle, scrollToOffset, scrollToTop, scrollY, scrollPosition, setScrollY]);

    return (
        <LayoutScrollContext.Provider value={value}>
            {children}
        </LayoutScrollContext.Provider>
    );
}

export function useLayoutScroll(): LayoutScrollContextValue {
    const ctx = useContext(LayoutScrollContext);
    if (!ctx) {
        throw new Error('useLayoutScroll must be used within a LayoutScrollProvider');
    }
    return ctx;
}

export default LayoutScrollContext;
