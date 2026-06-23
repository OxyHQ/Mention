import React, { useMemo } from 'react';
import { View, Platform, Text, Linking, StyleSheet } from "react-native";
import { useTranslation } from 'react-i18next';
import { SearchBar } from './SearchBar';
import { WidgetManager } from './widgets/WidgetManager';
import { VideosRail } from './videos/VideosRail';
import { useIsRightBarVisible } from '@/hooks/useOptimizedMediaQuery';
import { useVideosRail } from '@/context/VideosRailContext';

const LINK_STYLE = Platform.select({ web: { cursor: 'pointer' as any } });

// Static footer links that don't depend on translations — URLs never change
const STATIC_FOOTER_URLS = [
    { key: 'about', url: 'https://oxy.so/mention' },
    { key: 'privacy', url: 'https://oxy.so/company/transparency/policies/privacy' },
    { key: 'terms', url: 'https://oxy.so/company/transparency/policies/terms-of-service' },
    { key: 'cookies', url: 'https://oxy.so/company/transparency/policies/cookies' },
    { key: 'oxy', url: 'https://oxy.so/', label: 'Oxy' },
] as const;

export function RightBar() {
    const isRightBarVisible = useIsRightBarVisible();
    // The /videos screen is the sole writer of `active` — true ONLY while that
    // route is mounted. Reading it here keeps the rail swap reactive and exact
    // (no pathname string-matching), so the immersive rail mounts/unmounts in
    // lockstep with the videos screen.
    const { active: videosRailActive } = useVideosRail();

    if (!isRightBarVisible) return null;

    if (videosRailActive) {
        return (
            <View className="flex-col px-4 pt-4" style={styles.container}>
                <VideosRail />
            </View>
        );
    }

    return (
        <View className="flex-col px-4 pt-4 gap-4" style={styles.container}>
            <SearchBar />
            <WidgetManager screenId="home" />
            {Platform.OS === 'web' && <RightBarFooter />}
        </View>
    );
}

function RightBarFooter() {
    const { t } = useTranslation();

    const footerLinks = useMemo(() => STATIC_FOOTER_URLS.map((item) => ({
        label: 'label' in item ? item.label : t(`rightBar.${item.key}`),
        url: item.url,
    })), [t]);

    return (
        <View className="pb-3">
            <View className="flex-row flex-wrap">
                {footerLinks.map((link) => (
                    <FooterLink key={link.label} label={link.label} url={link.url} />
                ))}
            </View>
            <Text className="text-muted-foreground text-[12.5px] pt-0.5">Made with ❤️ in the 🌎 by Oxy.</Text>
        </View>
    );
}

// Extracted to its own component so that each link's onPress is stable via the
// component identity rather than a new arrow function created in the parent's map.
const FooterLink = React.memo(function FooterLink({ label, url }: { label: string; url: string }) {
    return (
        <Text
            className="text-muted-foreground text-[12.5px] pr-3 pb-1"
            style={LINK_STYLE}
            onPress={() => Linking.openURL(url)}
        >
            {label}
        </Text>
    );
});

const styles = StyleSheet.create({
    container: {
        width: 350,
        ...Platform.select({
            web: {
                position: 'sticky' as any,
                // `alignSelf: flex-start` keeps this column from being stretched
                // to the tall shell row's height (default flex stretch), so the
                // sticky box has room to pin while only the center feed scrolls.
                alignSelf: 'flex-start',
                top: 50,
                bottom: 20,
            },
        }),
    },
});
