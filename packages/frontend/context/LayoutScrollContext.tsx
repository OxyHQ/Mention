import React, { createContext, useContext } from 'react';
import { Animated } from 'react-native';

type LayoutScrollContextValue = {
    scrollY: Animated.Value;
};

const LayoutScrollContext = createContext<LayoutScrollContextValue | null>(null);

interface LayoutScrollProviderProps {
    scrollY: Animated.Value;
    children: React.ReactNode;
}

export function LayoutScrollProvider({ scrollY, children }: LayoutScrollProviderProps) {
    return (
        <LayoutScrollContext.Provider value={{ scrollY }}>
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


