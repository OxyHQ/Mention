import React, { useContext } from 'react';
import { View, Text } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Header } from '@/components/Header';
import { ThemedText } from '@/components/ThemedText';
import { SessionContext } from '@/modules/oxyhqservices/components/SessionProvider';
import Feed from '@/components/Feed';
import { router } from 'expo-router';

export default function BookmarksScreen() {
    const { t } = useTranslation();
    const session = useContext(SessionContext);

    if (!session?.getCurrentUserId()) {
        router.replace('/auth');
        return null;
    }

    return (
        <View className="flex-1 bg-white">
            <Header options={{
                title: t('Bookmarks'),
                subtitle: t('Your saved posts')
            }} />
            <Feed
                type="bookmarks"
                showCreatePost={false}
                className="pt-2"
            />
        </View>
    );
}
