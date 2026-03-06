import { useAuth } from '@oxyhq/services';
import { usePathname } from "expo-router";
import React from 'react';
import { StyleSheet, View, Platform, Text, Linking } from "react-native";
import { useMediaQuery } from 'react-responsive';
import { colors } from '../styles/colors';
import { SearchBar } from './SearchBar';
import { WidgetManager } from './widgets/WidgetManager';

export function RightBar() {
    const { user } = useAuth();
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
        { label: 'About', url: 'https://oxy.so/mention' },
        { label: 'Privacy', url: 'https://oxy.so/company/transparency/policies/privacy' },
        { label: 'Terms', url: 'https://oxy.so/company/transparency/policies/terms-of-service' },
        { label: 'Cookies', url: 'https://oxy.so/company/transparency/policies/cookies' },
        { label: 'Oxy', url: 'https://oxy.so/' },
    ];

    return (
        <View style={styles.footer}>
            <View style={styles.footerLinks}>
                {footerLinks.map((link) => (
                    <Text
                        key={link.label}
                        style={styles.footerLink}
                        onPress={() => Linking.openURL(link.url)}
                    >
                        {link.label}
                    </Text>
                ))}
            </View>
            <Text style={styles.footerBrand}>Made with ❤️ in the 🌎 by Oxy.</Text>
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
        paddingVertical: 12,
        paddingHorizontal: 4,
    },
    footerLinks: {
        flexDirection: 'row',
        flexWrap: 'wrap',
    },
    footerLink: {
        fontSize: 12.5,
        color: colors.text.secondary,
        paddingRight: 12,
        paddingBottom: 4,
        ...Platform.select({
            web: {
                cursor: 'pointer' as any,
            },
        }),
    },
    footerBrand: {
        fontSize: 12.5,
        color: colors.text.secondary,
        paddingTop: 2,
    },
});
