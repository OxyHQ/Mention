import React, { useMemo } from 'react';
import { View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { useSafeBack } from '@/hooks/useSafeBack';
import { SafeAreaView } from '@/lib/SafeAreaViewInterop';
import { ThemedText } from '@/components/ThemedText';
import { Header } from '@/components/Header';
import { IconButton } from '@/components/ui/Button';
import { BackArrowIcon } from '@/assets/icons/back-arrow-icon';
import { useTranslation } from 'react-i18next';
import Feed from '@/components/Feed/Feed';
import SEO from '@/components/SEO';
import { EntityFollowButton } from '@/components/EntityFollowButton';
import { PanelStickyHeader } from '@/components/shell/PanelChrome';

export default function HashtagScreen() {
    const { tag } = useLocalSearchParams<{ tag: string }>();
    const safeBack = useSafeBack();
    const { t } = useTranslation();

    const hashtag = tag?.replace(/^#/, '') || '';
    const displayTag = `#${hashtag}`;

    const filters = useMemo(() => ({ hashtag }), [hashtag]);

    const listHeader = useMemo(() => (
        <View className="px-4 pb-2">
            <View className="flex-row items-center justify-between">
                <ThemedText type="title" className="text-[28px] font-bold mb-1 font-primary flex-1">
                    {displayTag}
                </ThemedText>
                <EntityFollowButton entityType="hashtag" entityId={hashtag} label="Subscribe" followingLabel="Subscribed" />
            </View>
        </View>
    ), [displayTag, hashtag]);

    return (
        <SafeAreaView className="flex-1" edges={['top']}>
            <SEO
                title={t('seo.hashtag.title', { hashtag: displayTag, defaultValue: `${displayTag} - Mention` })}
                description={t('seo.hashtag.description', {
                    hashtag: displayTag,
                    defaultValue: `Posts tagged with ${displayTag} on Mention`
                })}
            />
            {/* PanelStickyHeader owns the web sticky position/inset + opaque
                panel surface; `disableSticky` on the inner <Header> hands sticky
                ownership to PanelStickyHeader so the header pins at PANEL_TOP_INSET
                (inside the panel) instead of top:0 (clipped by the bleed mask). */}
            <PanelStickyHeader level={0}>
                <Header
                    options={{
                        title: displayTag,
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
                type="hashtag"
                filters={filters}
                listHeaderComponent={listHeader}
            />
        </SafeAreaView>
    );
}
