import { useAuth } from '@oxyhq/services';
import { usePathname } from "expo-router";
import React from 'react';
import { StyleSheet, View, Platform, Text, Linking } from "react-native";
import { useMediaQuery } from 'react-responsive';
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
                        className="text-muted-foreground text-[12.5px] pr-3 pb-1"
                        style={Platform.select({ web: { cursor: 'pointer' as any } })}
                        onPress={() => Linking.openURL(link.url)}
                    >
                        {link.label}
                    </Text>
                ))}
            </View>
            <Text className="text-muted-foreground text-[12.5px] pt-0.5">Made with ❤️ in the 🌎 by Oxy.</Text>
        </View>
    );
}

const styles = StyleSheet.create({
    container: {
        width: 350,
        paddingStart: 20,
        flexDirection: 'column',
        gap: 14,
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
});
