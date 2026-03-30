import React, { useMemo } from 'react';
import { View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { useSafeBack } from '@/hooks/useSafeBack';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { ThemedText } from '@/components/ThemedText';
import { Header } from '@/components/Header';
import { IconButton } from '@/components/ui/Button';
import { BackArrowIcon } from '@/assets/icons/back-arrow-icon';
import { useTranslation } from 'react-i18next';
import Feed from '@/components/Feed/Feed';
import SEO from '@/components/SEO';
import { EntityFollowButton } from '@/components/EntityFollowButton';

export default function HashtagScreen() {
    const { tag } = useLocalSearchParams<{ tag: string }>();
    const safeBack = useSafeBack();
    const insets = useSafeAreaInsets();
    const { t } = useTranslation();

    const hashtag = tag?.replace(/^#/, '') || '';
    const displayTag = `#${hashtag}`;

    const filters = useMemo(() => ({ hashtag }), [hashtag]);

    const listHeader = useMemo(() => (
        <View className="px-4 pb-2" style={{ paddingTop: insets.top }}>
            <View className="flex-row items-center justify-between">
                <ThemedText type="title" className="text-[28px] font-bold mb-1 font-primary flex-1">
                    {displayTag}
                </ThemedText>
                <EntityFollowButton entityType="hashtag" entityId={hashtag} label="Subscribe" followingLabel="Subscribed" />
            </View>
        </View>
    ), [displayTag, hashtag, insets.top]);

    return (
        <SafeAreaView className="flex-1" edges={['top', 'bottom']}>
            <SEO
                title={t('seo.hashtag.title', { hashtag: displayTag, defaultValue: `${displayTag} - Mention` })}
                description={t('seo.hashtag.description', {
                    hashtag: displayTag,
                    defaultValue: `Posts tagged with ${displayTag} on Mention`
                })}
            />
            <Header
                options={{
                    title: displayTag,
                    leftComponents: [
                        <IconButton key="back" variant="icon" onPress={safeBack}>
                            <BackArrowIcon size={20} className="text-foreground" />
                        </IconButton>,
                    ],
                }}
            />
            <Feed
                type="hashtag"
                filters={filters}
                listHeaderComponent={listHeader}
            />
        </SafeAreaView>
    );
}
