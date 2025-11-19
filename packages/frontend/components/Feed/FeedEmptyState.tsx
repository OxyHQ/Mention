import React, { memo } from 'react';
import { FeedType } from '@mention/shared-types';
import { EmptyState } from '@/components/common/EmptyState';

interface FeedEmptyStateProps {
    isLoading: boolean;
    error: string | null;
    hasItems: boolean;
    type: FeedType;
    showOnlySaved?: boolean;
    onRetry?: () => Promise<void>;
}

/**
 * Feed empty state component
 * Handles loading, error, and empty states
 */
export const FeedEmptyState = memo<FeedEmptyStateProps>(
    ({ isLoading, error, hasItems, type, showOnlySaved, onRetry }) => {
        if (isLoading) return null;

        const hasError = !!error;
        const hasNoItems = !hasItems;

        if (hasError && hasNoItems && onRetry) {
            return (
                <EmptyState
                    error={{
                        title: "Couldn't load posts",
                        message: "Something went wrong while loading your feed. Pull down to refresh or tap the button below to try again.",
                        onRetry,
                    }}
                    icon={{
                        name: 'cloud-offline-outline',
                        size: 36,
                    }}
                />
            );
        }

        const emptyText = showOnlySaved ? 'No saved posts yet' : 'No posts yet';
        const emptySubtext = getEmptySubtext(type, showOnlySaved);

        return (
            <EmptyState
                title={emptyText}
                subtitle={emptySubtext}
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
            return 'No replies yet';
        case 'reposts':
            return 'No reposts yet';
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

