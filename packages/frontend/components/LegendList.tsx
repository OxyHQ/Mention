import React from 'react';
import { FlatList as RNFlatList, ScrollView } from 'react-native';
import { LegendList as RL } from '@legendapp/list';

// Small wrapper that prefers @legendapp/list's LegendList but falls back to RN FlatList when needed.
const LegendList = (props: any) => {
    const { refreshControl, ...rest } = props || {};

    // Prefer Legend List when available
    if (RL) {
        // If a refreshControl is provided, wrap the Legend List in a ScrollView that supports it.
        if (refreshControl) {
            return (
                <ScrollView refreshControl={refreshControl}>
                    <RL {...rest} />
                </ScrollView>
            ) as any;
        }

        return <RL {...rest} /> as any;
    }

    // Fallback to RN FlatList (supports refreshControl directly)
    return <RNFlatList refreshControl={refreshControl} {...rest} /> as any;
};

export default LegendList;
