import React from 'react';
import { View, Text, ScrollView, Linking } from 'react-native';
import { ThemedView } from '@/components/ThemedView';
import { Header } from '@/components/Header';
import { IconButton, Button } from '@/components/ui/Button';
import { BackArrowIcon } from '@/assets/icons/back-arrow-icon';
import { useTheme } from '@oxyhq/bloom/theme';
import { useSafeBack } from '@/hooks/useSafeBack';
import { useTranslation } from 'react-i18next';
import { Icon } from '@/lib/icons';
import { STRIPE_LINK_PLUS } from '@/config';

const FEATURES = [
    { icon: 'language-outline' as const, key: 'subscribe.translateFeature' },
    { icon: 'globe-outline' as const, key: 'subscribe.autoTranslateFeature' },
    { icon: 'sparkles-outline' as const, key: 'subscribe.aiFeatures' },
    { icon: 'shield-checkmark-outline' as const, key: 'subscribe.verifiedBadge' },
];

export default function SubscribeScreen() {
    const { t } = useTranslation();
    const safeBack = useSafeBack();
    const { colors } = useTheme();

    const handleSubscribe = () => {
        if (STRIPE_LINK_PLUS) {
            Linking.openURL(STRIPE_LINK_PLUS);
        }
    };

    return (
        <ThemedView className="flex-1">
            <Header
                options={{
                    title: t('subscribe.title'),
                    leftComponents: [
                        <IconButton variant="icon" key="back" onPress={() => safeBack()}>
                            <BackArrowIcon size={20} className="text-foreground" />
                        </IconButton>,
                    ],
                }}
                hideBottomBorder
                disableSticky
            />

            <ScrollView
                className="flex-1"
                contentContainerClassName="py-6 px-5"
                showsVerticalScrollIndicator={false}
            >
                <View className="items-center mb-8">
                    <Icon name="diamond-outline" size={48} color={colors.primary} />
                    <Text className="text-foreground text-2xl font-bold mt-4 text-center">
                        {t('subscribe.headline')}
                    </Text>
                    <Text className="text-muted-foreground text-base mt-2 text-center">
                        {t('subscribe.subtitle')}
                    </Text>
                </View>

                <View className="gap-4 mb-8">
                    {FEATURES.map((feature) => (
                        <View key={feature.key} className="flex-row items-center gap-3">
                            <View
                                className="w-10 h-10 rounded-full items-center justify-center"
                                style={{ backgroundColor: colors.primary + '15' }}
                            >
                                <Icon name={feature.icon} size={22} color={colors.primary} />
                            </View>
                            <Text className="text-foreground text-base flex-1">
                                {t(feature.key)}
                            </Text>
                        </View>
                    ))}
                </View>

                <Button onPress={handleSubscribe}>
                    <Text className="text-primary-foreground text-base font-semibold text-center">
                        {t('subscribe.cta')}
                    </Text>
                </Button>
            </ScrollView>
        </ThemedView>
    );
}
