import React, { useMemo } from 'react';
import { useLocalSearchParams } from 'expo-router';
import { useTranslation } from 'react-i18next';
import Feed from '@/components/Feed/Feed';
import { View } from 'react-native';
import { PageHeader } from '@oxy.so/bloom/page-header';
import { SEO } from '@/components/SEO';
import { useSafeBack } from '@/hooks/useSafeBack';

/**
 * The posts quoting a given post — where the "N quotes" count on the post-detail
 * screen leads. Quotes are posts, not actors, so this is a feed screen rather
 * than the user-list sheet that likes and boosts open.
 */
export default function PostQuotesScreen() {
    const { id } = useLocalSearchParams<{ id: string }>();
    const safeBack = useSafeBack();
    const { t } = useTranslation();

    const filters = useMemo(() => ({ postId: String(id) }), [id]);
    const title = t('post.quotes.title', { defaultValue: 'Quotes' });

    return (
        <View className="flex-1">
            <SEO
                title={title}
                description={t('post.quotes.description', {
                    defaultValue: 'Posts quoting this post on Mention',
                })}
            />
            <PageHeader
                title={title}
                onBack={() => safeBack()}
                backLabel={t('common.back', { defaultValue: 'Back' })}
            />
            <Feed type="quotes" filters={filters} />
        </View>
    );
}
