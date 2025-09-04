import React, { createContext, useContext } from 'react';
import { Animated } from 'react-native';

type LayoutScrollContextValue = {
    scrollY: Animated.Value;
};

const LayoutScrollContext = createContext<LayoutScrollContextValue | null>(null);

export const LayoutScrollProvider = LayoutScrollContext.Provider;

export function useLayoutScroll(): LayoutScrollContextValue | null {
    return useContext(LayoutScrollContext);
}

export default LayoutScrollContext;


