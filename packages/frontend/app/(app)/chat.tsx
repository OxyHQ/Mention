import React from 'react';
import { View, Text } from 'react-native';
import { useTranslation } from 'react-i18next';
import { StatusBar } from 'expo-status-bar';
import { useTheme } from '@oxy.so/bloom/theme';
import { PageHeader } from '@oxy.so/bloom/page-header';
import { useSafeBack } from '@/hooks/useSafeBack';
import { Chat } from '@/assets/icons/chat-icon';
import { SEO } from '@/components/SEO';

const ChatScreen: React.FC = () => {
    const { t } = useTranslation();
    const theme = useTheme();
    const safeBack = useSafeBack();

    return (
        <>
            <SEO title={t('Chat')} />
            <View className="flex-1">
                <StatusBar style={theme.isDark ? "light" : "dark"} />

                <PageHeader
                    title={t('Chat')}
                    onBack={() => safeBack()}
                    backLabel={t('common.back', { defaultValue: 'Back' })}
                />

                <View className="flex-1 items-center justify-center px-6">
                    <Chat size={64} className="text-primary mb-4" />
                    <Text className="text-2xl font-bold text-foreground mb-2">
                        {t('chat.comingSoon', 'Coming Soon')}
                    </Text>
                    <Text className="text-lg text-muted-foreground text-center leading-relaxed max-w-[320px]">
                        {t('chat.comingSoonDescription', 'We\'re building a real-time messaging experience so you can connect with your community directly. Stay tuned!')}
                    </Text>
                </View>
            </View>
        </>
    );
};

export default ChatScreen;
