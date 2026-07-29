import React, { useMemo } from 'react';
import { useLocalSearchParams } from 'expo-router';
import { useTranslation } from 'react-i18next';
import Feed from '@/components/Feed/Feed';
import { Header } from '@/components/Header';
import { IconButton } from '@/components/ui/Button';
import { BackArrowIcon } from '@/assets/icons/back-arrow-icon';
import { SEO } from '@/components/SEO';
import { SafeAreaView } from '@/lib/SafeAreaViewInterop';
import { PanelStickyHeader } from '@/components/shell/PanelChrome';
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
        <SafeAreaView className="flex-1" edges={['top']}>
            <SEO
                title={title}
                description={t('post.quotes.description', {
                    defaultValue: 'Posts quoting this post on Mention',
                })}
            />
            {/* Same chrome contract as every other secondary feed screen:
                PanelStickyHeader owns the web sticky inset and the opaque panel
                surface, so the inner Header hands sticky ownership over. */}
            <PanelStickyHeader level={0}>
                <Header
                    options={{
                        title,
                        leftComponents: [
                            <IconButton key="back" variant="icon" onPress={safeBack}>
                                <BackArrowIcon size={20} className="text-foreground" />
                            </IconButton>,
                        ],
                    }}
                    disableSticky
                />
            </PanelStickyHeader>
            <Feed type="quotes" filters={filters} />
        </SafeAreaView>
    );
}
