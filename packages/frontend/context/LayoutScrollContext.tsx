import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef } from 'react';
import { Animated, Platform } from 'react-native';

type ScrollEvent = {
    nativeEvent?: {
        contentOffset?: { x?: number; y?: number } | number;
        target?: { scrollTop?: number };
        [key: string]: any;
    };
    target?: { scrollTop?: number };
    [key: string]: any;
};

type WheelLikeEvent = {
    deltaY?: number;
    preventDefault?: () => void;
    target?: any;
    nativeEvent?: {
        deltaY?: number;
        preventDefault?: () => void;
        target?: any;
    };
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
     * Forward wheel events captured outside the main scroll view so the registered scrollable keeps control.
     */
    forwardWheelEvent: (event: WheelLikeEvent) => void;
};

const LayoutScrollContext = createContext<LayoutScrollContextValue | null>(null);

interface LayoutScrollProviderProps {
    children: React.ReactNode;
    scrollEventThrottle?: number;
}

function extractOffsetY(event: ScrollEvent): number {
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
    const scrollY = useMemo(() => new Animated.Value(0), []);
    const scrollableRef = useRef<ScrollableRef | null>(null);
    const scrollElementRef = useRef<HTMLElement | null>(null);
    const scrollPositionRef = useRef(0);
    const activeRegistrationId = useRef<number | null>(null);
    const registrationCounter = useRef(0);

    const setScrollY = useCallback((value: number) => {
        scrollY.setValue(value);
        scrollPositionRef.current = value;
    }, [scrollY]);

    const handleScroll = useCallback((event: ScrollEvent) => {
        const offset = extractOffsetY(event);
        setScrollY(offset);
        if (Platform.OS === 'web') {
            const target = (event?.nativeEvent as any)?.target ?? (event as any)?.target;
            if (target && typeof target.closest === 'function') {
                const owner = target.closest('[data-layoutscroll="true"]') as HTMLElement | null;
                if (owner) {
                    scrollElementRef.current = owner;
                }
            }
        }
    }, [setScrollY]);

    const createAnimatedScrollHandler = useCallback(
        (listener?: (event: ScrollEvent) => void) =>
            Animated.event(
                [{ nativeEvent: { contentOffset: { y: scrollY } } }],
                {
                    useNativeDriver: false,
                    listener: (event: ScrollEvent) => {
                        // The Animated.event mapping can no-op on some RN Web builds,
                        // so always mirror the value to keep the shared state in sync.
                        handleScroll(event);
                        listener?.(event);
                    },
                }
            ),
        [handleScroll, scrollY]
    );

    const registerScrollable = useCallback((ref: ScrollableRef | null) => {
        const id = ++registrationCounter.current;
        activeRegistrationId.current = id;
        scrollableRef.current = ref;
        scrollElementRef.current = null;
        return () => {
            if (activeRegistrationId.current === id) {
                scrollableRef.current = null;
                scrollElementRef.current = null;
                activeRegistrationId.current = null;
            }
        };
    }, []);

    useEffect(() => {
        const id = scrollY.addListener(({ value }) => {
            if (typeof value === 'number') {
                scrollPositionRef.current = value;
            }
        });
        return () => {
            scrollY.removeListener(id);
        };
    }, [scrollY]);

    const forwardWheelEvent = useCallback((event: WheelLikeEvent) => {
        if (Platform.OS !== 'web') return;
        const scroller = scrollableRef.current;
        if (!scroller) return;
        const deltaY = typeof event.deltaY === 'number'
            ? event.deltaY
            : typeof event.nativeEvent?.deltaY === 'number'
                ? event.nativeEvent?.deltaY
                : 0;
        if (deltaY === 0) return;
        const target = (event.nativeEvent?.target ?? event.target) as HTMLElement | null;
        if (target && scrollElementRef.current && typeof target.closest === 'function') {
            const owner = target.closest('[data-layoutscroll="true"]');
            if (owner && owner === scrollElementRef.current) {
                // Let the scrollable itself handle native wheel events.
                return;
            }
        }

        if (typeof event.preventDefault === 'function') {
            event.preventDefault();
        } else if (typeof event.nativeEvent?.preventDefault === 'function') {
            event.nativeEvent.preventDefault();
        }

        const nextOffset = Math.max(0, scrollPositionRef.current + deltaY);
        if (typeof scroller.scrollToOffset === 'function') {
            scroller.scrollToOffset({ offset: nextOffset, animated: false });
        } else if (typeof scroller.scrollTo === 'function') {
            scroller.scrollTo({ y: nextOffset, animated: false });
        }
    }, []);

    const value = useMemo<LayoutScrollContextValue>(() => ({
        scrollY,
        scrollEventThrottle: Platform.OS === 'web' ? Math.max(8, scrollEventThrottle) : scrollEventThrottle,
        handleScroll,
        createAnimatedScrollHandler,
        setScrollY,
        registerScrollable,
        forwardWheelEvent,
    }), [createAnimatedScrollHandler, forwardWheelEvent, handleScroll, registerScrollable, scrollEventThrottle, scrollY, setScrollY]);

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
