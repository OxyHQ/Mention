import React, { useMemo } from 'react';
import { View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { PageHeader } from '@oxy.so/bloom/page-header';
import { Text } from '@oxy.so/bloom/typography';
import { useSafeBack } from '@/hooks/useSafeBack';
import { useTranslation } from 'react-i18next';
import Feed from '@/components/Feed/Feed';
import { SEO } from '@/components/SEO';
import { EntityFollowButton } from '@/components/EntityFollowButton';

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
                <Text className="text-[28px] leading-8 font-bold mb-1 font-primary flex-1 text-foreground">
                    {displayTag}
                </Text>
                <EntityFollowButton entityType="hashtag" entityId={hashtag} label="Subscribe" followingLabel="Subscribed" />
            </View>
        </View>
    ), [displayTag, hashtag]);

    return (
        <View className="flex-1">
            <SEO
                title={t('seo.hashtag.title', { hashtag: displayTag, defaultValue: '{{hashtag}} - Mention' })}
                description={t('seo.hashtag.description', {
                    hashtag: displayTag,
                    defaultValue: 'Posts tagged with {{hashtag}} on Mention'
                })}
            />
            <PageHeader
                title={displayTag}
                onBack={() => safeBack()}
                backLabel={t('common.back', { defaultValue: 'Back' })}
            />
            <Feed
                type="hashtag"
                filters={filters}
                listHeaderComponent={listHeader}
            />
        </View>
    );
}
