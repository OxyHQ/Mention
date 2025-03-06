import React, { useContext, useState, useEffect } from 'react';
import { View, Text } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Header } from '@/components/Header';
import { ThemedText } from '@/components/ThemedText';
import { SessionContext } from '@/modules/oxyhqservices/components/SessionProvider';
import Feed from '@/components/Feed';
import { router } from 'expo-router';
import { feedService } from '@/services/feedService';

export default function BookmarksScreen() {
    const { t } = useTranslation();
    const session = useContext(SessionContext);
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);

    // Add effect to check if the bookmarks API is working
    useEffect(() => {
        const checkBookmarksApi = async () => {
            try {
                setLoading(true);
                setError(null);

                // Try to fetch bookmarks directly to test the API
                const response = await feedService.fetchFeed('bookmarks', {
                    limit: 1
                });

                console.log('Bookmarks API test result:', {
                    postCount: response.posts.length,
                    hasMore: response.hasMore,
                    success: true
                });
            } catch (err) {
                console.error('Bookmarks API error:', err);
                setError(err instanceof Error ? err.message : 'Failed to fetch bookmarks');
            } finally {
                setLoading(false);
            }
        };

        checkBookmarksApi();
    }, []);

    return (
        <View className="flex-1">
            <Header options={{
                title: t('Bookmarks'),
                subtitle: t('Your saved posts')
            }} />

            {error && (
                <View className="p-4 bg-red-100 dark:bg-red-900 m-2 rounded-lg">
                    <ThemedText className="text-red-800 dark:text-red-200">
                        Error loading bookmarks: {error}
                    </ThemedText>
                </View>
            )}

            <Feed
                type="bookmarks"
                showCreatePost={false}
                className="pt-2"
            />
        </View>
    );
}
