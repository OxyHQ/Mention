import React from 'react';
import { View, Text } from 'react-native';
import { Stack } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ThemedView } from '@/components/ThemedView';
import { Chat } from '@/assets/icons/chat-icon';
import SEO from '@/components/SEO';

const ChatScreen: React.FC = () => {
    const { t } = useTranslation();
    const insets = useSafeAreaInsets();

    return (
        <>
            <SEO title={t('Chat')} />
            <ThemedView className="flex-1" style={{ paddingTop: insets.top }}>
                <Stack.Screen options={{ title: t('Chat'), headerShown: true }} />
                <View className="flex-1 items-center justify-center px-6">
                    <Chat size={64} className="text-muted-foreground mb-4" />
                    <Text className="text-2xl font-bold text-foreground mb-2">
                        {t('chat.comingSoon', 'Coming Soon')}
                    </Text>
                    <Text className="text-base text-muted-foreground text-center">
                        {t('chat.comingSoonDescription', 'Chat is under development. Stay tuned!')}
                    </Text>
                </View>
            </ThemedView>
        </>
    );
};

export default ChatScreen;
