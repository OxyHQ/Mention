import React, { useMemo } from 'react';
import { View, Platform, Text, StyleSheet } from "react-native";
import { useTranslation } from 'react-i18next';
import { SearchBar } from './SearchBar';
import { WidgetManager } from './widgets/WidgetManager';
import { openExternalLink } from '@/utils/openExternalLink';
import { VideoReplies } from './videos/VideoReplies';
import { ContentPanel } from '@oxyhq/bloom/content-panel';
import { useIsRightBarVisible } from '@/hooks/useOptimizedMediaQuery';
import { useVideosRail } from '@/context/VideosRailContext';
import { asViewStyle, asTextStyle, type WebViewStyle } from '@/types/webStyles';

// `cursor` is a web-only CSS property absent from RN's `TextStyle` — author it
// through the shared extended TextStyle and bridge at the consumption point
// rather than using an `as any` cast (same pattern as SideBar/SearchBar).
const LINK_STYLE = Platform.OS === 'web' ? asTextStyle({ cursor: 'pointer' }) : undefined;

// `position: 'sticky'` is a valid react-native-web value absent from RN's native
// `ViewStyle['position']` union — author the web container style through the
// shared extended ViewStyle (same pattern as SideBar) rather than an `as any` cast.
const RIGHTBAR_STICKY_TOP = 50;
const RIGHTBAR_STICKY_BOTTOM = 20;

const webStickyContainer: WebViewStyle = {
    position: 'sticky',
    // `alignSelf: flex-start` keeps this column from being stretched to the tall
    // shell row's height (default flex stretch), so the sticky box has room to
    // pin while only the center feed scrolls.
    alignSelf: 'flex-start',
    top: RIGHTBAR_STICKY_TOP,
    bottom: RIGHTBAR_STICKY_BOTTOM,
};

// The videos replies column needs an explicit height equal to the sticky slot
// (viewport height minus the same top/bottom offsets above) so `VideoReplies` —
// which is `flex: 1` with no intrinsic height — fills the sticky window and
// scrolls its own content instead of collapsing to zero height.
const videosRailStickyHeight: WebViewStyle = {
    height: `calc(100vh - ${RIGHTBAR_STICKY_TOP + RIGHTBAR_STICKY_BOTTOM}px)`,
};

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
    const { active: videosRailActive, activePost, onCommentPosted } = useVideosRail();

    if (!isRightBarVisible) return null;

    if (videosRailActive) {
        return (
            <View style={styles.videosRepliesContainer}>
                {activePost && (
                    <ContentPanel
                        framed={false}
                        surfaceClassName="bg-card rounded-radius-28 border border-border overflow-hidden"
                    >
                        <VideoReplies
                            postId={activePost.id}
                            onCommentPosted={() => onCommentPosted(activePost.id)}
                        />
                    </ContentPanel>
                )}
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
            onPress={() => openExternalLink(url)}
        >
            {label}
        </Text>
    );
});

const styles = StyleSheet.create({
    container: {
        width: 350,
        ...(Platform.OS === 'web' ? asViewStyle(webStickyContainer) : null),
    },
    // The /videos right bar shows ONLY the replies panel, at the SAME 350px
    // width the widgets use on every other screen (`styles.container`, above).
    // On web it's sticky + full-height (the sticky-slot height) so the embedded
    // `VideoReplies` fills it and scrolls its own content.
    videosRepliesContainer: {
        width: 350,
        ...(Platform.OS === 'web'
            ? asViewStyle({ ...webStickyContainer, ...videosRailStickyHeight })
            : null),
    },
});
