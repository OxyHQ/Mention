import React from 'react';
import { View, Text } from 'react-native';
import { useTranslation } from 'react-i18next';
import { StatusBar } from 'expo-status-bar';
import { useTheme } from '@oxyhq/bloom/theme';
import { SafeAreaView } from '@/lib/SafeAreaViewInterop';
import { ThemedView } from '@/components/ThemedView';
import { Header } from '@/components/Header';
import { IconButton } from '@/components/ui/Button';
import { BackArrowIcon } from '@/assets/icons/back-arrow-icon';
import { useSafeBack } from '@/hooks/useSafeBack';
import { Chat } from '@/assets/icons/chat-icon';
import SEO from '@/components/SEO';

const ChatScreen: React.FC = () => {
    const { t } = useTranslation();
    const theme = useTheme();
    const safeBack = useSafeBack();

    return (
        <>
            <SEO title={t('Chat')} />
            <SafeAreaView className="flex-1 bg-background" edges={['top']}>
                <ThemedView className="flex-1">
                    <StatusBar style={theme.isDark ? "light" : "dark"} />

                    <Header
                        options={{
                            title: t('Chat'),
                            leftComponents: [
                                <IconButton variant="icon" key="back" onPress={safeBack}>
                                    <BackArrowIcon size={20} className="text-foreground" />
                                </IconButton>,
                            ],
                        }}
                        hideBottomBorder={true}
                        disableSticky={true}
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
                </ThemedView>
            </SafeAreaView>
        </>
    );
};

export default ChatScreen;
