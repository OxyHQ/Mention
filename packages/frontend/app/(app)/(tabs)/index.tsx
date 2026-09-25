import React, { useState, useEffect, useMemo } from 'react';
import { View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { StatusBar } from 'expo-status-bar';
import { router } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import Feed from '@/components/Feed/Feed';
import { customFeedsService } from '@/services/customFeedsService';
import { useFeedPreferences } from '@/hooks/useFeedPreferences';
import { PRESET_FEEDS } from '@mention/shared-types/mtn/presetFeeds';
import { parseFeedDescriptor } from '@mention/shared-types/mtn/feedDescriptor';
import type { FeedType } from '@mention/shared-types/feed';
import { Tabs, TabsTrigger } from '@oxy.so/bloom/tabs';
import { useTheme } from '@oxy.so/bloom/theme';
import { useReselectReloadKey, useTabSelect } from '@/context/ScreenReselectContext';
import { SEO } from '@/components/SEO';
import { useAuth } from '@oxy.so/services/ui/client';
import { logger } from '@oxy.so/core/logger';
import { viewerQueryKeys } from '@/lib/viewerQueryKeys';

type HomeTab = string;

/**
 * A resolved home tab derived from a pinned {@link SavedFeed}. `descriptor` tabs
 * render an inline `<Feed>`; `custom` tabs render the engine timeline.
 *
 * `custom` cannot be folded into `descriptor`: `FeedType` and
 * `FeedDescriptorSource` are two overlapping unions, and the `source as FeedType`
 * cast below type-checks for a source that is not a feed type at all — producing
 * a tab that fetches nothing, at runtime, with no error. A custom feed is scoped
 * by a FILTER, so it takes its own shape.
 */
type HomeTabModel =
    | { key: string; label: string; kind: 'descriptor'; type: FeedType }
    | { key: string; label: string; kind: 'custom'; feedId: string };

const HomeScreen: React.FC = () => {
    const { t } = useTranslation();
    const { isAuthResolved, canUsePrivateApi, user } = useAuth();
    const theme = useTheme();
    const [activeTab, setActiveTab] = useState<HomeTab>('for_you');
    const refreshKey = useReselectReloadKey();
    // The home tabs ARE the viewer's server-persisted pinned feeds (server order),
    // so pinning in the feeds screen updates the tab bar cross-device. Anonymous
    // viewers get the read-only default (For You).
    const { pinnedFeeds } = useFeedPreferences();

    const presetById = useMemo(() => new Map(PRESET_FEEDS.map((p) => [p.id, p])), []);

    // Whether any pinned feed is a custom feed — gates the (title-only) custom-feed
    // fetch so users with no custom pins never trigger it.
    const hasPinnedCustom = useMemo(
        () => pinnedFeeds.some((sf) => parseFeedDescriptor(sf.descriptor).source === 'custom'),
        [pinnedFeeds],
    );

    // Resolve custom-feed ids → titles for the tab labels (pinned custom feeds
    // carry only a descriptor). Keyed on the auth identity; cached + deduped.
    const customTitlesQuery = useQuery<Map<string, string>>({
        queryKey: viewerQueryKeys.customFeedTitles(user?.id),
        enabled: canUsePrivateApi && hasPinnedCustom,
        staleTime: 5 * 60 * 1000,
        queryFn: async () => {
            const map = new Map<string, string>();
            try {
                const [mine, pub] = await Promise.all([
                    customFeedsService.list({ mine: true }),
                    customFeedsService.list({ publicOnly: true }),
                ]);
                [...(mine.items || []), ...(pub.items || [])].forEach((feed) => {
                    const feedId = String(feed._id || feed.id);
                    if (!map.has(feedId)) map.set(feedId, feed.title || t('feeds.untitled', { defaultValue: 'Feed' }));
                });
            } catch (error) {
                logger.warn('Failed to load custom feed titles', { error });
            }
            return map;
        },
    });

    const customTitles = customTitlesQuery.data;

    const homeTabs = useMemo<HomeTabModel[]>(() => {
        return pinnedFeeds
            .filter((sf) => {
                // Belt-and-suspenders: hide viewer-relative presets + custom feeds
                // for anonymous viewers (the hook's anon default already excludes them).
                if (canUsePrivateApi) return true;
                const preset = presetById.get(sf.key);
                return preset ? !preset.requiresAuth : false;
            })
            .map((sf): HomeTabModel => {
                const { source, params } = parseFeedDescriptor(sf.descriptor);
                if (source === 'custom') {
                    const feedId = params[0] ?? '';
                    return {
                        key: sf.key,
                        kind: 'custom',
                        feedId,
                        label: customTitles?.get(feedId) ?? t('feeds.untitled', { defaultValue: 'Feed' }),
                    };
                }
                const preset = presetById.get(sf.key);
                return {
                    key: sf.key,
                    kind: 'descriptor',
                    type: source as FeedType,
                    label: preset ? t(preset.labelKey) : sf.descriptor,
                };
            });
    }, [pinnedFeeds, canUsePrivateApi, presetById, customTitles, t]);

    useEffect(() => {
        // Keep the active tab valid as the pinned set changes (e.g. logout removes
        // Following / custom tabs → fall back to the first tab, For You). Only act
        // once auth is RESOLVED so the cold-boot window doesn't fight a session
        // that is about to restore.
        if (!isAuthResolved) return;
        if (homeTabs.length > 0 && !homeTabs.some((tab) => tab.key === activeTab)) {
            setActiveTab(homeTabs[0].key);
        }
    }, [isAuthResolved, homeTabs, activeTab]);

    const handleTabPress = useTabSelect(activeTab, setActiveTab);

    const renderContent = () => {
        // Feeds that render in both the anon and authed branches (for_you, …) must
        // remount when the auth identity flips so their mount-time fetch re-runs
        // against the now-ready token. Without an identity-scoped key, React
        // reconciles the same element across the anon→authed transition and the feed
        // stays stuck on anonymous (or empty) content. This is the belt-and-suspenders
        // guarantee alongside the auth-keyed initial-fetch effect inside useFeedState.
        const feedIdentity = canUsePrivateApi && user?.id ? user.id : 'anon';

        // Resolve the active tab; fall back to the first tab (For You) if the active
        // key is momentarily stale (the reset effect converges it next render).
        const tab = homeTabs.find((x) => x.key === activeTab) ?? homeTabs[0];
        const composeProps = canUsePrivateApi
            ? { showComposeButton: true, onComposePress: () => router.push('/compose') }
            : {};

        if (!tab) {
            return <Feed key={`for_you-${feedIdentity}`} type="for_you" reloadKey={refreshKey} {...composeProps} />;
        }

        if (tab.kind === 'custom') {
            return (
                <Feed
                    key={`custom-${tab.feedId}-${feedIdentity}`}
                    type="custom"
                    filters={{ customFeedId: tab.feedId }}
                    reloadKey={refreshKey}
                    {...composeProps}
                />
            );
        }

        return (
            <Feed
                key={`${tab.type}-${feedIdentity}`}
                type={tab.type}
                reloadKey={refreshKey}
                {...composeProps}
            />
        );
    };

    return (
        <>
            <SEO
                title={t('seo.home.title')}
                description={t('seo.home.description')}
            />
            <View className="flex-1">
                <StatusBar style={theme.isDark ? "light" : "dark"} />
                <Tabs value={activeTab} onValueChange={handleTabPress} variant="underline" style={{ height: 38 }}>
                    {homeTabs.map(tab => <TabsTrigger key={tab.key} value={tab.key} label={tab.label}
                        style={{ height: 38, minWidth: 76, paddingLeft: 12, paddingRight: 12, paddingTop: 0, paddingBottom: 0 }}
                        textStyle={{ fontSize: 15, lineHeight: 18, fontWeight: activeTab === tab.key ? '700' : '500' }} />)}
                </Tabs>
                {renderContent()}
            </View>
        </>
    );
};

export default HomeScreen;
