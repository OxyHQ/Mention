import { memo } from 'react';
import { View, Text } from 'react-native';
import { Image } from 'expo-image';
import { useTranslation } from 'react-i18next';
import type { FeedType } from '@mention/shared-types';
import type { FeedFailureKind } from '@/utils/feedRetry';
import { EmptyState } from '@/components/common/EmptyState';
import { Spinner } from '@/components/ui/Spinner';

interface FeedEmptyStateProps {
    isLoading: boolean;
    error: string | null;
    /**
     * What kind of failure `error` was. Only `offline` changes what the reader
     * is told — retrying is futile until the connection is back, and they are
     * the one who can fix it. Everything else reads as a passing hiccup.
     */
    errorKind?: FeedFailureKind | null;
    hasItems: boolean;
    type: FeedType;
    showOnlySaved?: boolean;
    onRetry?: () => Promise<void>;
    /**
     * True while a federated profile feed is still populating in the background
     * (auto-refetching). Shows a loading state instead of the empty placeholder.
     */
    pending?: boolean;
}

/**
 * Feed empty state component
 * Handles loading, error, and empty states
 */
export const FeedEmptyState = memo<FeedEmptyStateProps>(
    ({ isLoading, error, errorKind, hasItems, type, showOnlySaved, onRetry, pending }) => {
        const { t } = useTranslation();
        if (isLoading || pending) return (
            <View className="items-center justify-center py-12 gap-3">
                <Spinner />
                {pending && (
                    <Text className="text-muted-foreground text-sm">
                        {t('feed.loadingPosts', { defaultValue: 'Loading posts…' })}
                    </Text>
                )}
            </View>
        );

        const hasError = !!error;
        const hasNoItems = !hasItems;

        // A feed that failed with nothing to show. By the time this renders the
        // read has already been retried and given up (`utils/feedRetry`), and
        // `isLoading` covered every attempt above — so a transient backend blip
        // never gets this far while a retry is still pending.
        //
        // Deliberately quiet: the title and the Try again button, with no
        // alarm-red icon disc, because "the server had a moment" is not the
        // reader's problem to solve. An OFFLINE device is the exception — that
        // one they can act on, so it keeps the connection icon and says so.
        if (hasError && hasNoItems && onRetry) {
            const isOffline = errorKind === 'offline';
            return (
                <EmptyState
                    error={{
                        title: t('feed.empty.title'),
                        message: isOffline
                            ? t('No connection. Check your network and try again.', {
                                defaultValue: 'No connection. Check your network and try again.',
                            })
                            : t('feed.empty.message'),
                        onRetry,
                    }}
                    icon={isOffline ? { name: 'cloud-offline-outline', size: 36 } : undefined}
                />
            );
        }

        return (
            <EmptyState
                title={showOnlySaved ? 'No saved posts yet' : 'No posts yet'}
                subtitle={getEmptySubtext(type, showOnlySaved)}
                customIcon={
                    /* Decorative: EmptyState already announces the title and
                       subtitle as a single accessibility element. */
                    <Image
                        source={require('@/assets/images/empty-state-illustration.png')}
                        className="w-[120px] max-w-full aspect-[258/134]"
                        contentFit="contain"
                        alt=""
                        accessibilityElementsHidden
                        importantForAccessibility="no"
                    />
                }
            />
        );
    }
);

FeedEmptyState.displayName = 'FeedEmptyState';

function getEmptySubtext(type: FeedType, showOnlySaved?: boolean): string {
    if (showOnlySaved) {
        return 'Posts you save will appear here. Tap the bookmark icon on any post to save it.';
    }

    switch (type) {
        case 'posts':
            return 'Be the first to share something!';
        case 'media':
            return 'No media posts found';
        case 'replies':
            return 'No replies yet. Be the first to reply!';
        case 'boosts':
            return 'No boosts yet';
        case 'explore':
            return 'No trending posts right now. Check back later!';
        case 'following':
            return 'Start following people to see their posts';
        case 'for_you':
            return 'Discover posts based on your interests';
        case 'custom':
            return 'This feed is empty';
        default:
            return 'Start following people to see their posts';
    }
}
