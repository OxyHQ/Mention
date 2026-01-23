import { useOxy } from '@oxyhq/services/full';
import { usePathname } from "expo-router";
import React from 'react';
import { StyleSheet, View, Platform, Text, Linking } from "react-native";
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
            {Platform.OS === 'web' && <RightBarFooter />}
        </View>
    )
}

function RightBarFooter() {
    const footerLinks = [
        { label: 'About', url: '#' },
        { label: 'Privacy', url: '#' },
        { label: 'Terms', url: '#' },
        { label: 'Cookies', url: '#' },
    ];

    const handleLinkPress = (url: string) => {
        if (url !== '#') {
            Linking.openURL(url);
        }
    };

    return (
        <View style={styles.footer}>
            <View style={styles.footerLinks}>
                {footerLinks.map((link, index) => (
                    <React.Fragment key={link.label}>
                        <Text
                            style={styles.footerLink}
                            onPress={() => handleLinkPress(link.url)}
                        >
                            {link.label}
                        </Text>
                        {index < footerLinks.length - 1 && (
                            <Text style={styles.footerSeparator}>·</Text>
                        )}
                    </React.Fragment>
                ))}
            </View>
            <Text style={styles.footerBrand}>
                Made with ❤️ in the 🌎 by Oxy.
            </Text>
        </View>
    );
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
    footer: {
        paddingVertical: 16,
        paddingHorizontal: 16,
        gap: 8,
    },
    footerLinks: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 8,
        alignItems: 'center',
    },
    footerLink: {
        fontSize: 13,
        color: colors.text.secondary,
        ...Platform.select({
            web: {
                cursor: 'pointer' as any,
                textDecoration: 'none' as any,
            },
        }),
    },
    footerSeparator: {
        fontSize: 13,
        color: colors.text.secondary,
        marginHorizontal: 4,
    },
    footerBrand: {
        fontSize: 13,
        color: colors.text.secondary,
        marginTop: 4,
    },
});
