import React, { useCallback, useContext, useEffect, useMemo, useRef } from 'react';
import { FlatList as RNFlatList, Platform } from 'react-native';
import { LegendList as RL } from '@legendapp/list';
import LayoutScrollContext from '@/context/LayoutScrollContext';

// Small wrapper that prefers @legendapp/list's LegendList but falls back to RN FlatList when needed.
// Improvements:
// - Pass refreshControl directly to RL (no ScrollView wrapper) since RL supports it.
// - Keep FlatList fallback for environments without @legendapp/list.
const LegendList = (props: any, ref: any) => {
    const {
        refreshControl,
        scrollEnabled = true,
        onScroll: propOnScroll,
        scrollEventThrottle: propScrollEventThrottle,
        dataSet,
        onWheel: propOnWheel,
        ...rest
    } = props || {};

    const layoutScroll = useContext(LayoutScrollContext);
    const localRef = useRef<any>(null);
    const unregisterRef = useRef<(() => void) | null>(null);

    const clearRegistration = useCallback(() => {
        if (unregisterRef.current) {
            unregisterRef.current();
            unregisterRef.current = null;
        }
    }, []);

    const combinedRef = useCallback((node: any) => {
        localRef.current = node;
        if (typeof ref === 'function') {
            ref(node);
        } else if (ref && typeof ref === 'object') {
            ref.current = node;
        }
    }, [ref]);

    useEffect(() => {
        if (!layoutScroll?.registerScrollable || scrollEnabled === false) {
            clearRegistration();
            return;
        }
        if (localRef.current) {
            unregisterRef.current = layoutScroll.registerScrollable(localRef.current);
        }
        return () => {
            clearRegistration();
        };
    }, [clearRegistration, layoutScroll?.registerScrollable, scrollEnabled]);

    const handleScroll = layoutScroll?.handleScroll;

    const mergedOnScroll = useCallback((event: any) => {
        if (scrollEnabled !== false && handleScroll) {
            handleScroll(event);
        }
        if (typeof propOnScroll === 'function') {
            propOnScroll(event);
        }
    }, [handleScroll, propOnScroll, scrollEnabled]);

    const handleWheelEvent = useCallback((event: any) => {
        if (layoutScroll?.forwardWheelEvent) {
            layoutScroll.forwardWheelEvent(event);
        }
        if (typeof propOnWheel === 'function') {
            propOnWheel(event);
        }
    }, [layoutScroll?.forwardWheelEvent, propOnWheel]);

    const effectiveScrollEventThrottle = useMemo(() => {
        if (propScrollEventThrottle != null) return propScrollEventThrottle;
        return layoutScroll?.scrollEventThrottle;
    }, [layoutScroll?.scrollEventThrottle, propScrollEventThrottle]);

    const datasetForWeb = useMemo(() => {
        if (Platform.OS !== 'web') return dataSet;
        return { ...(dataSet || {}), layoutscroll: 'true' };
    }, [dataSet]);

    // Prefer Legend List when available
    if (RL) {
        // Apply safe defaults for high-performance use cases, but let callers override.
        const defaults = {
            // Recycle item components by default for better performance. Callers can opt out.
            recycleItems: true,
            // Keep visible content position when prepending items (useful for chat-like UIs).
            maintainVisibleContentPosition: true,
        } as any;

        const propsForRL = {
            ...defaults,
            ...rest,
            refreshControl,
            scrollEnabled,
            onScroll: layoutScroll ? mergedOnScroll : propOnScroll,
            dataSet: datasetForWeb,
            onWheel: Platform.OS === 'web' ? handleWheelEvent : propOnWheel,
        } as any;

        if (effectiveScrollEventThrottle != null) {
            propsForRL.scrollEventThrottle = effectiveScrollEventThrottle;
        }

        // Pass everything to RL; explicit props from `rest` will override defaults.
        return <RL ref={combinedRef} {...propsForRL} /> as any;
    }

    // Fallback to RN FlatList (supports refreshControl directly)
    const fallbackProps: any = {
        ...rest,
        refreshControl,
        scrollEnabled,
        onScroll: layoutScroll ? mergedOnScroll : propOnScroll,
        dataSet: datasetForWeb,
        onWheel: Platform.OS === 'web' ? handleWheelEvent : propOnWheel,
    };
    if (effectiveScrollEventThrottle != null) {
        fallbackProps.scrollEventThrottle = effectiveScrollEventThrottle;
    }
    return <RNFlatList ref={combinedRef} {...fallbackProps} /> as any;
};

export default React.forwardRef(LegendList) as any;
