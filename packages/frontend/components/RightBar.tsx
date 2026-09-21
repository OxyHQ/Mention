import React, { useMemo } from 'react';
import { View, Platform, Text } from "react-native";
import { useTranslation } from 'react-i18next';
import { SearchBar } from './SearchBar';
import { WidgetManager } from './widgets/WidgetManager';
import { openExternalLink } from '@/utils/openExternalLink';
import { VideoReplies } from './videos/VideoReplies';
import { ContentPanel } from '@oxy.so/bloom/content-panel';
import { useTheme } from '@oxy.so/bloom/theme';
import { useIsRightBarVisible } from '@/hooks/useOptimizedMediaQuery';
import { useVideosRail } from '@/context/VideosRailContext';
import { asTextStyle } from '@/types/webStyles';

// `cursor` is a web-only CSS property absent from RN's `TextStyle` — author it
// through the shared extended TextStyle and bridge at the consumption point
// rather than using an `as any` cast (same pattern as SideBar/SearchBar).
const LINK_STYLE = Platform.OS === 'web' ? asTextStyle({ cursor: 'pointer' }) : undefined;

// Static footer links that don't depend on translations — URLs never change
const STATIC_FOOTER_URLS = [
    { key: 'about', url: 'https://oxy.so/mention' },
    { key: 'privacy', url: 'https://oxy.so/company/transparency/policies/privacy' },
    { key: 'terms', url: 'https://oxy.so/company/transparency/policies/terms-of-service' },
    { key: 'cookies', url: 'https://oxy.so/company/transparency/policies/cookies' },
    { key: 'oxy', url: 'https://oxy.so/', label: 'Oxy' },
    // CrowdSource decides Mention's moderation cases (and will own community
    // notes), so readers can see who does. A product name, never translated.
    { key: 'crowdsource', url: 'https://crowdsource.oxy.so/', label: 'CrowdSource' },
] as const;

export function RightBar() {
    const isRightBarVisible = useIsRightBarVisible();
    const { colors } = useTheme();
    // The /videos screen is the sole writer of `active` — true ONLY while that
    // route is mounted. Reading it here keeps the rail swap reactive and exact
    // (no pathname string-matching), so the immersive rail mounts/unmounts in
    // lockstep with the videos screen.
    const { active: videosRailActive, activePost, onCommentPosted } = useVideosRail();

    if (!isRightBarVisible) return null;

    if (videosRailActive) {
        return (
            <View className="flex-1 min-h-0 web:h-[calc(100dvh-16px)]">
                {/* `surfaceClassName` repaints the surface, which is a utility
                    Bloom cannot resolve to a colour — so without `surfaceColor`
                    the panel publishes its rung alone and the composer pinned
                    inside it cannot match what it is on. */}
                {activePost && (
                    <ContentPanel
                        framed={false}
                        surfaceClassName="bg-card rounded-radius-28 border border-border overflow-hidden"
                        surfaceColor={colors.card}
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
        // No column `gap` — each child owns its own bottom margin, see `BaseWidget`.
        <View className="flex-col px-[14px] pt-4">
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
            <Text className="text-muted-foreground text-[12.5px] pt-0.5">Made with ❤️ in the 🌎 by Oxy&trade;.</Text>
            {/* No legal notice under the links on purpose: "Mention" carries no
                trademark claim here, and Oxy's work is under its own licenses,
                not an all-rights-reserved copyright line. */}
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
