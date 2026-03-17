import React from 'react';
import { View, Text, ScrollView, Alert, Platform } from 'react-native';
import Constants from 'expo-constants';
import { ThemedView } from '@/components/ThemedView';
import { useSafeBack } from '@/hooks/useSafeBack';
import { Header } from '@/components/Header';
import { IconButton } from '@/components/ui/Button';
import { BackArrowIcon } from '@/assets/icons/back-arrow-icon';
import { LogoIcon } from '@/assets/logo';
import { useTheme } from '@/hooks/useTheme';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@oxyhq/services';
import { SettingsItem, SettingsGroup } from '@/components/settings/SettingsItem';
import { confirmDialog, alertDialog } from '@/utils/alerts';

export default function AboutScreen() {
    const { t } = useTranslation();
    const safeBack = useSafeBack();
    const { colors } = useTheme();
    const { showBottomSheet } = useAuth() as { showBottomSheet?: (screen: string) => void };

    const appVersion = Constants.expoConfig?.version || '1.0.0';
    const runtimeVersion = typeof Constants.expoConfig?.runtimeVersion === 'string'
        ? Constants.expoConfig.runtimeVersion
        : t('settings.aboutMention.buildVersion');

    const platformName = Constants.platform?.ios
        ? 'iOS'
        : Constants.platform?.android
            ? 'Android'
            : 'Web';

    const constantsAny = Constants as any;
    const manifestAny = Constants.manifest as any;

    const expoSdkVersion =
        (Constants.expoConfig && (Constants.expoConfig.sdkVersion || Constants.expoConfig.runtimeVersion)) ||
        (manifestAny && (manifestAny.sdkVersion || manifestAny.releaseChannel)) ||
        constantsAny.expoRuntimeVersion || constantsAny.expoVersion ||
        'Unknown';

    const oxySdkVersion =
        constantsAny.oxyVersion ||
        (Constants.expoConfig &&
            (Constants.expoConfig.extra?.oxyVersion || Constants.expoConfig.extra?.oxySDKVersion)) ||
        (manifestAny &&
            (manifestAny.extra?.oxyVersion || manifestAny.extra?.oxySDKVersion)) ||
        'Unknown';

    const apiUrl = process.env.EXPO_PUBLIC_API_URL || process.env.API_URL || 'Not set';

    const handleClearCache = async () => {
        const confirmed = await confirmDialog({
            title: t('settings.data.clearCache'),
            message: t('settings.data.clearCacheMessage'),
            okText: t('common.clear'),
            cancelText: t('common.cancel'),
            destructive: true,
        });
        if (!confirmed) return;
        await alertDialog({
            title: t('common.success'),
            message: t('settings.data.clearCacheSuccess'),
        });
    };

    return (
        <ThemedView className="flex-1">
            <Header
                options={{
                    title: t('settings.aboutMention.title', { defaultValue: 'About' }),
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
                {/* App identity */}
                <View className="items-center py-6 mb-4">
                    <View className="w-16 h-16 rounded-2xl items-center justify-center bg-primary/10 mb-3">
                        <LogoIcon size={32} className="text-primary" />
                    </View>
                    <Text className="text-xl font-bold text-foreground">
                        {t('settings.aboutMention.appName')}
                    </Text>
                    <Text className="text-sm text-muted-foreground mt-1">
                        {t('settings.aboutMention.version', { version: appVersion })}
                    </Text>
                </View>

                {/* System info */}
                <SettingsGroup title={t('settings.aboutMention.systemInfo', { defaultValue: 'System information' })}>
                    <SettingsItem
                        icon="hammer"
                        title={t('settings.aboutMention.build')}
                        badgeText={String(runtimeVersion)}
                        showChevron={false}
                    />
                    <SettingsItem
                        icon="phone-portrait"
                        title={t('settings.aboutMention.platform')}
                        badgeText={platformName}
                        showChevron={false}
                    />
                    <SettingsItem
                        icon="code-slash"
                        title={t('settings.aboutMention.expoSDK')}
                        badgeText={String(expoSdkVersion)}
                        showChevron={false}
                    />
                    <SettingsItem
                        icon="code-slash"
                        title={t('settings.aboutMention.oxySDK')}
                        badgeText={String(oxySdkVersion)}
                        onPress={() => showBottomSheet?.('AppInfo')}
                    />
                    <SettingsItem
                        icon="globe"
                        title={t('settings.aboutMention.apiUrl')}
                        badgeText={apiUrl}
                        showChevron={false}
                    />
                </SettingsGroup>

                {/* Support */}
                <SettingsGroup title={t('settings.sections.supportFeedback')}>
                    <SettingsItem
                        icon="help-circle"
                        title={t('settings.supportFeedback.helpSupport')}
                        description={t('settings.supportFeedback.helpSupportDesc')}
                        onPress={() => {
                            Alert.alert(
                                t('settings.supportFeedback.helpSupport'),
                                t('settings.supportFeedback.helpSupportMessage'),
                                [{ text: t('common.ok') }],
                            );
                        }}
                    />
                    <SettingsItem
                        icon="chatbubble"
                        title={t('settings.supportFeedback.sendFeedback')}
                        description={t('settings.supportFeedback.sendFeedbackDesc')}
                        onPress={() => {
                            Alert.alert(
                                t('settings.supportFeedback.sendFeedback'),
                                t('settings.supportFeedback.sendFeedbackMessage'),
                                [
                                    { text: t('common.cancel'), style: 'cancel' },
                                    {
                                        text: t('common.sendFeedback'),
                                        onPress: () => {
                                            Alert.alert(
                                                t('common.success'),
                                                t('settings.supportFeedback.sendFeedbackThankYou'),
                                            );
                                        },
                                    },
                                ],
                            );
                        }}
                    />
                </SettingsGroup>

                {/* Debug */}
                <SettingsGroup title={t('settings.debug', { defaultValue: 'Debug' })}>
                    <SettingsItem
                        icon="trash"
                        title={t('settings.data.clearCache')}
                        description={t('settings.data.clearCacheDesc')}
                        onPress={handleClearCache}
                        destructive
                    />
                </SettingsGroup>
            </ScrollView>
        </ThemedView>
    );
}
