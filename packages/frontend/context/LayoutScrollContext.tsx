import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef } from 'react';
import { Animated, Platform } from 'react-native';

const IS_WEB = Platform.OS === 'web';

export type ScrollEvent = {
    nativeEvent?: {
        contentOffset?: { x?: number; y?: number } | number;
        target?: { scrollTop?: number };
        [key: string]: any;
    };
    target?: { scrollTop?: number };
    [key: string]: any;
};

type ScrollableRef = {
    scrollToOffset?: (params: { offset: number; animated?: boolean }) => void;
    scrollTo?: (params: { x?: number; y?: number; animated?: boolean }) => void;
};

type LayoutScrollContextValue = {
    scrollY: Animated.Value;
    scrollEventThrottle: number;
    /**
     * Imperatively update the shared scrollY based on a synthetic scroll event.
     * Provides a fallback for components that cannot use Animated.event (e.g. LegendList web)
     */
    handleScroll: (event: ScrollEvent) => void;
    /**
     * Factory that returns an Animated.event handler bound to the shared scrollY.
     * Consumers can provide an optional listener to run side effects alongside the shared update.
     */
    createAnimatedScrollHandler: (listener?: (event: ScrollEvent) => void) => (...args: any[]) => void;
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
    if (target && typeof target.scrollTop === 'number') return target.scrollTop;

    return 0;
}

export function LayoutScrollProvider({
    children,
    scrollEventThrottle = 16,
}: LayoutScrollProviderProps) {
    const scrollY = useRef(new Animated.Value(0)).current;
    const scrollableRef = useRef<ScrollableRef | null>(null);
    const scrollPositionRef = useRef(0);
    const activeRegistrationId = useRef<number | null>(null);
    const registrationCounter = useRef(0);

    const setScrollY = useCallback((value: number) => {
        scrollY.setValue(value);
        scrollPositionRef.current = value;
    }, [scrollY]);

    // WEB document-scroll model: the BODY is the scroller (no inner feed
    // ScrollView), so a single window 'scroll' listener here is the source of
    // truth for the shared scrollY. This replaces the per-feed onScroll →
    // handleScroll path on web and keeps every consumer (BottomBar auto-hide,
    // HomeScreen header/FAB) working unchanged. Subscribing to an external
    // mutable store (window scroll) is a legitimate useEffect — same
    // justification as useBottomBarVisibility's listener. No-op on native, which
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
            
            return Animated.event(
                [{ nativeEvent: { contentOffset: { y: scrollY } } }],
                {
                    useNativeDriver: false, // Required for scroll position
                    listener: (event: any) => {
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

    const scrollToTop = useCallback(() => {
        // WEB: scroll the document back to the top — the body is the scroller.
        if (IS_WEB) {
            if (typeof window !== 'undefined') {
                window.scrollTo({ top: 0, behavior: 'smooth' });
            }
            return;
        }
        const scroller = scrollableRef.current;
        if (!scroller) return;
        if (typeof scroller.scrollToOffset === 'function') {
            scroller.scrollToOffset({ offset: 0, animated: true });
        } else if (typeof scroller.scrollTo === 'function') {
            scroller.scrollTo({ y: 0, animated: true });
        }
    }, []);

    const value = useMemo<LayoutScrollContextValue>(() => ({
        scrollY,
        scrollEventThrottle: Math.max(16, scrollEventThrottle),
        handleScroll,
        createAnimatedScrollHandler,
        setScrollY,
        registerScrollable,
        scrollToTop,
    }), [createAnimatedScrollHandler, handleScroll, registerScrollable, scrollEventThrottle, scrollToTop, scrollY, setScrollY]);

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
