import React from 'react';
import { View, Text, ScrollView, Linking } from 'react-native';
import { ThemedView } from '@/components/ThemedView';
import { Header } from '@/components/Header';
import { IconButton, PrimaryButton } from '@/components/ui/Button';
import { BackArrowIcon } from '@/assets/icons/back-arrow-icon';
import { useSafeBack } from '@/hooks/useSafeBack';
import { useTranslation } from 'react-i18next';
import { Icon } from '@/lib/icons';
import { SettingsItem, SettingsGroup } from '@/components/settings/SettingsItem';
import { STRIPE_LINK_PLUS } from '@/config';

export default function SubscribeScreen() {
    const { t } = useTranslation();
    const safeBack = useSafeBack();

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
                contentContainerClassName="px-4 pt-4 pb-8"
                showsVerticalScrollIndicator={false}
            >
                {/* Hero */}
                <View className="items-center py-6 mb-4">
                    <View className="w-16 h-16 rounded-2xl items-center justify-center bg-primary/10 mb-3">
                        <Icon name="diamond-outline" size={32} className="text-primary" />
                    </View>
                    <Text className="text-xl font-bold text-foreground">
                        {t('subscribe.headline')}
                    </Text>
                    <Text className="text-sm text-muted-foreground mt-1 text-center">
                        {t('subscribe.subtitle')}
                    </Text>
                </View>

                {/* Features */}
                <SettingsGroup title={t('subscribe.featuresTitle')}>
                    <SettingsItem icon="language" title={t('subscribe.translateFeature')} showChevron={false} />
                    <SettingsItem icon="globe" title={t('subscribe.autoTranslateFeature')} showChevron={false} />
                    <SettingsItem icon="sparkles" title={t('subscribe.aiFeatures')} showChevron={false} />
                    <SettingsItem icon="shield-checkmark" title={t('subscribe.verifiedBadge')} showChevron={false} />
                </SettingsGroup>

                {/* CTA */}
                <View className="px-4 mt-2">
                    <PrimaryButton size="large" onPress={handleSubscribe}>
                        {t('subscribe.cta')}
                    </PrimaryButton>
                </View>
            </ScrollView>
        </ThemedView>
    );
}
