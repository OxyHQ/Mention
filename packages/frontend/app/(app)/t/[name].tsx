import React, { useMemo } from 'react';
import { View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { useSafeBack } from '@/hooks/useSafeBack';
import { SafeAreaView } from '@/lib/SafeAreaViewInterop';
import { ThemedText } from '@/components/ThemedText';
import { Header } from '@/components/Header';
import { IconButton } from '@/components/ui/Button';
import { BackArrowIcon } from '@/assets/icons/back-arrow-icon';
import { useTranslation } from 'react-i18next';
import Feed from '@/components/Feed/Feed';
import type { FeedType } from '@mention/shared-types';
import { SEO } from '@/components/SEO';
import { PanelStickyHeader } from '@/components/shell/PanelChrome';
import { trendingService } from '@/services/trendingService';
import { useTrendsStore } from '@/stores/trendsStore';
import { publicQueryKeys } from '@/lib/viewerQueryKeys';

export default function TrendScreen() {
    // The TERM is the whole address. Everything shown about the trend is
    // resolved from it, never carried alongside it.
    const { name } = useLocalSearchParams<{ name: string }>();
    const safeBack = useSafeBack();
    const { t } = useTranslation();

    const term = name || '';

    /*
     * The label comes from the live trends the app already holds when the term
     * is one of them — instant, and correct by construction because it is the
     * same state every other surface renders. A cold deep link has no such
     * entry and falls back to the fetched detail, then to the term itself.
     */
    const listed = useTrendsStore((state) =>
        state.trends.find((trend) => trend.text === term),
    );

    /*
     * The generated explanation of what is happening — the ONE place this
     * feature spends anything on a model, and only for trends people actually
     * open. The request itself is the demand signal the server counts, so:
     *
     *  - `refetchOnMount: 'always'` — one request per open, which is what a
     *    "view" is meant to mean. A cached read would undercount demand and a
     *    trend could sit one open below the threshold forever.
     *  - no window-focus refetch, no polling — those are opens nobody made, and
     *    counting them would buy prose on the strength of a tab regaining focus.
     *
     * Absent is the ordinary answer (below the threshold, or no key configured),
     * and the screen is complete without it.
     */
    const { data: detail } = useQuery({
        queryKey: publicQueryKeys.trendSummary(term),
        queryFn: () => trendingService.getTrendDetail(term),
        enabled: term.length > 0,
        staleTime: 0,
        refetchOnMount: 'always',
        refetchOnWindowFocus: false,
    });

    /*
     * `trend|<term>`, NOT `topic|<term>`: the trend feed matches the same union
     * of extracted terms, hashtags and topic slugs that detection counted, so a
     * trend detected purely from prose still opens onto its posts.
     *
     * Passed as a DESCRIPTOR, the same way every other parametrized feed is
     * addressed. A second addressing shape (a `type` plus a matching filter)
     * would be a second thing to keep in step for no gain — this screen and the
     * feeds directory now request the identical feed the identical way.
     */
    const feedType = useMemo(() => `trend|${term}` as FeedType, [term]);

    const heading = listed?.displayName || detail?.displayName || term;
    const summary = detail?.description;
    const category = listed?.category ?? detail?.category;
    const categoryLabel = category
        ? t(`trend.category.${category}`, { defaultValue: '' })
        : '';

    const listHeader = useMemo(() => (
        <View className="px-4 pb-2">
            <ThemedText className="text-xs text-muted-foreground font-medium uppercase tracking-wide mb-1 font-primary">
                {categoryLabel || t('trend.trendingLabel', { defaultValue: 'Trending' })}
            </ThemedText>
            <ThemedText type="title" className="text-[28px] font-bold mb-1 font-primary">
                {heading}
            </ThemedText>
            {summary ? (
                <ThemedText className="text-sm text-muted-foreground font-primary">
                    {summary}
                </ThemedText>
            ) : null}
        </View>
    ), [heading, summary, categoryLabel, t]);

    return (
        <SafeAreaView className="flex-1" edges={['top']}>
            <SEO
                title={t('seo.trend.title', { topic: heading, defaultValue: '{{topic}} - Mention' })}
                description={t('seo.trend.description', {
                    topic: heading,
                    defaultValue: 'Posts about {{topic}} on Mention',
                })}
            />
            {/* PanelStickyHeader owns the web sticky position/inset + opaque
                panel surface; `disableSticky` on the inner <Header> hands sticky
                ownership to PanelStickyHeader so the header pins at PANEL_TOP_INSET
                (inside the panel) instead of top:0 (clipped by the bleed mask). */}
            <PanelStickyHeader level={0}>
                <Header
                    options={{
                        title: heading,
                        leftComponents: [
                            <IconButton key="back" variant="icon" onPress={safeBack}>
                                <BackArrowIcon size={20} className="text-foreground" />
                            </IconButton>,
                        ],
                    }}
                    disableSticky
                />
            </PanelStickyHeader>
            <Feed
                type={feedType}
                listHeaderComponent={listHeader}
            />
        </SafeAreaView>
    );
}
