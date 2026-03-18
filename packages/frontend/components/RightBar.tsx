import { useAuth } from '@oxyhq/services';
import { usePathname } from "expo-router";
import React from 'react';
import { View, Platform, Text, Linking, StyleSheet } from "react-native";
import { useMediaQuery } from 'react-responsive';
import { useTranslation } from 'react-i18next';
import { SearchBar } from './SearchBar';
import { WidgetManager } from './widgets/WidgetManager';

export function RightBar() {
    const { user } = useAuth();
    const isRightBarVisible = useMediaQuery({ minWidth: 990 });
    const pathname = usePathname();
    const isExplorePage = pathname === '/explore';

    if (!isRightBarVisible) return null;

    return (
        <View className="flex-col ps-5" style={styles.container}>
            <SearchBar />
            <View className="mt-2">
                <WidgetManager screenId="home" />
            </View>
            {Platform.OS === 'web' && <RightBarFooter />}
        </View>
    )
}

function RightBarFooter() {
    const { t } = useTranslation();
    const footerLinks = [
        { label: t('rightBar.about'), url: 'https://oxy.so/mention' },
        { label: t('rightBar.privacy'), url: 'https://oxy.so/company/transparency/policies/privacy' },
        { label: t('rightBar.terms'), url: 'https://oxy.so/company/transparency/policies/terms-of-service' },
        { label: t('rightBar.cookies'), url: 'https://oxy.so/company/transparency/policies/cookies' },
        { label: 'Oxy', url: 'https://oxy.so/' },
    ];

    return (
        <View className="pt-2 pb-3 px-1">
            <View className="flex-row flex-wrap">
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
        ...Platform.select({
            web: {
                position: 'sticky' as any,
                top: 50,
                bottom: 20,
            },
        }),
    },
});
