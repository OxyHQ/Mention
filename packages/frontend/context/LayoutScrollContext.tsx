import React, { createContext, useContext, useMemo } from 'react';
import { Animated, ScrollViewProps } from 'react-native';

type LayoutScrollContextValue = {
    scrollY: Animated.Value;
};

const LayoutScrollContext = createContext<LayoutScrollContextValue | null>(null);

interface LayoutScrollProviderProps {
    children: React.ReactNode;
    // optional styling props forwarded to the internal ScrollView
    contentContainerStyle?: ScrollViewProps['contentContainerStyle'];
    style?: ScrollViewProps['style'];
    scrollEventThrottle?: number;
}

export function LayoutScrollProvider({
    children,
    contentContainerStyle,
    style,
    scrollEventThrottle = 16,
}: LayoutScrollProviderProps) {
    const scrollY = useMemo(() => new Animated.Value(0), []);

    return (
        <LayoutScrollContext.Provider value={{ scrollY }}>
            <Animated.ScrollView
                contentContainerStyle={contentContainerStyle}
                style={style}
                onScroll={Animated.event(
                    [{ nativeEvent: { contentOffset: { y: scrollY } } }],
                    { useNativeDriver: false }
                )}
                scrollEventThrottle={scrollEventThrottle}
            >
                {children}
            </Animated.ScrollView>
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


