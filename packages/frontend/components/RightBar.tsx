import { useOxy } from '@oxyhq/services/full';
import { usePathname } from "expo-router";
import React from 'react';
import { StyleSheet, View, Platform } from "react-native";
import { useMediaQuery } from 'react-responsive';
import { colors } from '../styles/colors';
import { SearchBar } from './SearchBar';
import { WidgetManager } from './widgets/WidgetManager';

export function RightBar() {
    const { user } = useOxy();
    const isRightBarVisible = useMediaQuery({ minWidth: 990 });
    const pathname = usePathname();
    const isExplorePage = pathname === '/explore';

    if (!isRightBarVisible) return null;

    return (
        <View style={styles.container}>
            <SearchBar />
            {/* Trends now handled via WidgetManager (TrendsWidget) */}
            <WidgetManager screenId="home" />
        </View>
    )
}

const styles = StyleSheet.create({
    container: {
        width: 350,
        paddingStart: 20,
        flexDirection: 'column',
        gap: 20,
        ...Platform.select({
            web: {
                position: 'sticky' as any,
                top: 50,
                bottom: 20,
            },
        }),
    },
});
