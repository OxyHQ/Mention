import React from 'react';
import { FlatList as RNFlatList } from 'react-native';
import { LegendList as RL } from '@legendapp/list';

// Small wrapper that prefers @legendapp/list's LegendList but falls back to RN FlatList when needed.
// Improvements:
// - Pass refreshControl directly to RL (no ScrollView wrapper) since RL supports it.
// - Keep FlatList fallback for environments without @legendapp/list.
const LegendList = (props: any, ref: any) => {
    const { refreshControl, ...rest } = props || {};

    // Prefer Legend List when available
    if (RL) {
        // Apply safe defaults for high-performance use cases, but let callers override.
        const defaults = {
            // Recycle item components by default for better performance. Callers can opt out.
            recycleItems: true,
            // Keep visible content position when prepending items (useful for chat-like UIs).
            maintainVisibleContentPosition: true,
        } as any;

        const propsForRL = { ...defaults, ...rest, refreshControl };

        // Pass everything to RL; explicit props from `rest` will override defaults.
        return <RL ref={ref} {...propsForRL} /> as any;
    }

    // Fallback to RN FlatList (supports refreshControl directly)
    return <RNFlatList ref={ref} refreshControl={refreshControl} {...rest} /> as any;
};

export default React.forwardRef(LegendList) as any;
