import React from 'react';
import { View, Text, ScrollView, Linking, Platform } from 'react-native';
import { PageHeader } from '@oxy.so/bloom/page-header';
import { Button } from '@oxy.so/bloom/button';
import { useTheme } from '@oxy.so/bloom/theme';
import { useSafeBack } from '@/hooks/useSafeBack';
import { useTranslation } from 'react-i18next';
import { SettingsListGroup, SettingsListItem } from '@oxy.so/bloom/settings-list';
import { RowIcon } from '@/components/settings/RowIcon';
import { RiShieldCheckLine, RiSparklingLine, RiVipCrownLine } from '@oxy.so/bloom/icons';
import { STRIPE_LINK_PLUS } from '@/config';

export default function SubscribeScreen() {
    const { t } = useTranslation();
    const safeBack = useSafeBack();
    const { colors } = useTheme();

    const handleSubscribe = () => {
        if (STRIPE_LINK_PLUS) {
            Linking.openURL(STRIPE_LINK_PLUS);
        }
    };

    const body = (
        <>
            {/* Hero */}
            <View className="items-center py-6 mb-4">
                <View className="w-16 h-16 rounded-2xl items-center justify-center bg-primary/10 mb-3">
                    <RiVipCrownLine size="2xl" fill={colors.primary} />
                </View>
                <Text className="text-xl font-bold text-foreground">
                    {t('subscribe.headline')}
                </Text>
                <Text className="text-sm text-muted-foreground mt-1 text-center">
                    {t('subscribe.subtitle')}
                </Text>
            </View>

            {/* Features */}
            <SettingsListGroup variant="filled" title={t('subscribe.featuresTitle')}>
                <SettingsListItem icon={<RowIcon icon={RiSparklingLine} />} title={t('subscribe.aiFeatures')} showChevron={false} />
                <SettingsListItem icon={<RowIcon icon={RiShieldCheckLine} />} title={t('subscribe.verifiedBadge')} showChevron={false} />
            </SettingsListGroup>

            {/* CTA */}
            <View className="px-4 mt-2">
                <Button variant="primary" size="large" onPress={handleSubscribe}>
                    {t('subscribe.cta')}
                </Button>
            </View>
        </>
    );

    return (
        <View className="flex-1">
            <PageHeader
                title={t('subscribe.title')}
                onBack={() => safeBack()}
                backLabel={t('common.back', { defaultValue: 'Back' })}
            />

            {/* WEB hands scroll to the shared panel/document (no nested scroller that
                would break sticky rails + window scroll restoration); NATIVE keeps a
                ScrollView as the screen's scroller — the standard RN idiom. */}
            {Platform.OS === 'web' ? (
                <View className="px-4 pt-4 pb-8">{body}</View>
            ) : (
                <ScrollView
                    className="flex-1"
                    contentContainerClassName="px-screen-margin pt-4 pb-8"
                    showsVerticalScrollIndicator={false}
                >
                    {body}
                </ScrollView>
            )}
        </View>
    );
}
