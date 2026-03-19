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

export default function TrendScreen() {
    const { name, description, type } = useLocalSearchParams<{
        name: string;
        description?: string;
        type?: string;
    }>();
    const safeBack = useSafeBack();
    const insets = useSafeAreaInsets();
    const { t } = useTranslation();

    const topicName = name || '';
    const topicDescription = description || '';
    const topicType = type || 'topic';

    const filters = useMemo(() => ({ topic: topicName }), [topicName]);

    const typeLabel = topicType === 'entity'
        ? t('trend.typeEntity', { defaultValue: 'Entity' })
        : t('trend.typeTopic', { defaultValue: 'Topic' });

    const listHeader = useMemo(() => (
        <View className="px-4 pb-2" style={{ paddingTop: insets.top }}>
            <ThemedText className="text-xs text-muted-foreground font-medium uppercase tracking-wide mb-1 font-primary">
                {t('trend.trendingLabel', { defaultValue: `Trending ${typeLabel}` })}
            </ThemedText>
            <ThemedText type="title" className="text-[28px] font-bold mb-1 font-primary">
                {topicName}
            </ThemedText>
            {topicDescription ? (
                <ThemedText className="text-sm text-muted-foreground font-primary">
                    {topicDescription}
                </ThemedText>
            ) : null}
        </View>
    ), [topicName, topicDescription, typeLabel, insets.top, t]);

    return (
        <SafeAreaView className="flex-1" edges={['top', 'bottom']}>
            <SEO
                title={t('seo.trend.title', { topic: topicName, defaultValue: `${topicName} - Mention` })}
                description={t('seo.trend.description', {
                    topic: topicName,
                    defaultValue: `Posts about ${topicName} on Mention`,
                })}
            />
            <Header
                options={{
                    title: topicName,
                    leftComponents: [
                        <IconButton key="back" variant="icon" onPress={safeBack}>
                            <BackArrowIcon size={20} className="text-foreground" />
                        </IconButton>,
                    ],
                }}
            />
            <Feed
                type="topic"
                filters={filters}
                listHeaderComponent={listHeader}
            />
        </SafeAreaView>
    );
}
