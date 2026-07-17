import React, { useMemo } from 'react';
import { useLocalSearchParams } from 'expo-router';
import { Loading } from '@oxyhq/bloom/loading';
import { useSafeBack } from '@/hooks/useSafeBack';
import { SafeAreaView } from '@/lib/SafeAreaViewInterop';
import { Header } from '@/components/Header';
import { IconButton } from '@/components/ui/Button';
import { BackArrowIcon } from '@/assets/icons/back-arrow-icon';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@oxyhq/services';
import Feed from '@/components/Feed/Feed';
import SEO from '@/components/SEO';
import { EmptyState } from '@/components/common/EmptyState';
import { PanelStickyHeader } from '@/components/shell/PanelChrome';
import { PRESET_FEEDS, type FeedType } from '@mention/shared-types';

/**
 * Read-only viewer for a descriptor-addressed feed that has no dedicated detail
 * screen. Two kinds open here:
 *  - a built-in PRESET feed — the feeds catalog (`app/(app)/feeds.tsx`) links here
 *    with the preset's `descriptor` + resolved `title` so a viewer can OPEN it
 *    without pinning; each resolves against the shared `PRESET_FEEDS` catalog.
 *  - a FEED GENERATOR (`feedgen|<uri>`) — a synced Bluesky feed surfaced on a
 *    profile's Feeds tab; opening it runs the remote algorithm through the MTN
 *    engine and renders its output as native posts.
 * Native custom feeds keep their own detail screen (`feeds/[id].tsx`).
 *
 * `<Feed>` is the single scroll owner here — the same window-virtualizer web
 * path the home screen uses — so there is no second top-level virtualizer.
 */
export default function PresetFeedViewScreen() {
    const { descriptor, title } = useLocalSearchParams<{ descriptor: string; title: string }>();
    const safeBack = useSafeBack();
    const { t } = useTranslation();
    const { canUsePrivateApi, isPrivateApiPending } = useAuth();

    // A feed-generator descriptor (`feedgen|<uri>`) is served straight through the
    // MTN engine — it is not a preset and never viewer-gated (a public algorithm).
    const isFeedGenerator = typeof descriptor === 'string' && descriptor.startsWith('feedgen|');

    // Resolve the preset from the shared catalog to get its label + auth flag.
    // Every remaining preset descriptor (for_you / following / trending /
    // explore / mutuals / friends_popular) is a plain, non-parametrized token
    // that is also a valid `FeedType`, so it maps straight onto `<Feed type>`.
    const preset = useMemo(
        () => (isFeedGenerator ? undefined : PRESET_FEEDS.find((p) => p.descriptor === descriptor)),
        [descriptor, isFeedGenerator],
    );

    const headerTitle = title || (preset ? t(preset.labelKey) : t('feeds.untitled', { defaultValue: 'Feed' }));

    // requiresAuth presets are viewer-relative — only signed-in viewers can open
    // them. The catalog already hides these rows from anonymous viewers, so this
    // guard only fires on a direct deep link.
    const gated = Boolean(preset?.requiresAuth) && !canUsePrivateApi;

    const renderBody = () => {
        // A feed generator carries its content path in the descriptor itself, so it
        // renders straight through the engine (no preset lookup, no auth gate).
        if (isFeedGenerator) {
            return <Feed type={descriptor as FeedType} />;
        }
        if (!preset) {
            return (
                <EmptyState
                    icon={{ name: 'help-circle-outline' }}
                    title={t('feeds.view.notFound.title', { defaultValue: 'Feed not found' })}
                    subtitle={t('feeds.view.notFound.subtitle', { defaultValue: 'This feed is no longer available.' })}
                    containerStyle={{ paddingTop: 60 }}
                />
            );
        }
        if (gated) {
            // During the cold-boot SSO restore window the session may still land,
            // so wait it out before showing the anonymous prompt.
            if (isPrivateApiPending) {
                return <Loading className="text-primary" size="large" style={{ flex: undefined, marginTop: 60 }} />;
            }
            return (
                <EmptyState
                    icon={{ name: 'lock-closed-outline' }}
                    title={t('feeds.view.signInRequired.title', { defaultValue: 'Sign in to view this feed' })}
                    subtitle={t('feeds.view.signInRequired.subtitle', { defaultValue: 'This feed is personalized to your account.' })}
                    containerStyle={{ paddingTop: 60 }}
                />
            );
        }
        return <Feed type={preset.descriptor as FeedType} />;
    };

    return (
        <SafeAreaView className="flex-1" edges={['top', 'bottom']}>
            <SEO title={headerTitle} description={t('seo.feeds.description')} />
            {/* PanelStickyHeader owns the web sticky position/inset + opaque panel
                surface; `disableSticky` on the inner <Header> hands sticky
                ownership to PanelStickyHeader so the header pins at
                PANEL_TOP_INSET (inside the panel) instead of top:0. */}
            <PanelStickyHeader level={0}>
                <Header
                    options={{
                        title: headerTitle,
                        leftComponents: [
                            <IconButton key="back" variant="icon" onPress={safeBack}>
                                <BackArrowIcon size={20} className="text-foreground" />
                            </IconButton>,
                        ],
                    }}
                    disableSticky
                />
            </PanelStickyHeader>
            {renderBody()}
        </SafeAreaView>
    );
}
