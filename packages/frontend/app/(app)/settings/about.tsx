import React from 'react';
import { View, Text, ScrollView, Platform } from 'react-native';
import { show as toast } from '@oxyhq/bloom/toast';
import { useRouter } from 'expo-router';
import Constants from 'expo-constants';
import { ThemedView } from '@/components/ThemedView';
import { useSafeBack } from '@/hooks/useSafeBack';
import { Header } from '@/components/Header';
import { IconButton } from '@/components/ui/Button';
import { BackArrowIcon } from '@/assets/icons/back-arrow-icon';
import { LogoIcon } from '@/assets/logo';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@oxyhq/services';
import { SettingsListGroup, SettingsListItem } from '@oxyhq/bloom/settings-list';
import { RowIcon } from '@/components/settings/RowIcon';
import { confirmDialog, alertDialog } from '@/utils/alerts';

export default function AboutScreen() {
    const { t } = useTranslation();
    const safeBack = useSafeBack();
    const { showBottomSheet } = useAuth() as { showBottomSheet?: (screen: string) => void };
    const router = useRouter();

    const appVersion = Constants.expoConfig?.version || '1.0.0';
    const runtimeVersion = typeof Constants.expoConfig?.runtimeVersion === 'string'
        ? Constants.expoConfig.runtimeVersion
        : t('settings.aboutMention.buildVersion');

    const platformName = Constants.platform?.ios
        ? 'iOS'
        : Constants.platform?.android
            ? 'Android'
            : 'Web';

    const expoSdkVersion =
        Constants.expoConfig?.sdkVersion ||
        (typeof Constants.expoConfig?.runtimeVersion === 'string'
            ? Constants.expoConfig.runtimeVersion
            : undefined) ||
        'Unknown';

    const oxySdkVersion =
        Constants.expoConfig?.extra?.oxyVersion ||
        Constants.expoConfig?.extra?.oxySDKVersion ||
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
                <SettingsListGroup title={t('settings.aboutMention.systemInfo', { defaultValue: 'System information' })}>
                    <SettingsListItem
                        icon={<RowIcon name="hammer" />}
                        title={t('settings.aboutMention.build')}
                        value={String(runtimeVersion)}
                        showChevron={false}
                    />
                    <SettingsListItem
                        icon={<RowIcon name="phone-portrait" />}
                        title={t('settings.aboutMention.platform')}
                        value={platformName}
                        showChevron={false}
                    />
                    <SettingsListItem
                        icon={<RowIcon name="code-slash" />}
                        title={t('settings.aboutMention.expoSDK')}
                        value={String(expoSdkVersion)}
                        showChevron={false}
                    />
                    <SettingsListItem
                        icon={<RowIcon name="code-slash" />}
                        title={t('settings.aboutMention.oxySDK')}
                        value={String(oxySdkVersion)}
                        onPress={() => showBottomSheet?.('AppInfo')}
                    />
                    <SettingsListItem
                        icon={<RowIcon name="globe" />}
                        title={t('settings.aboutMention.apiUrl')}
                        value={apiUrl}
                        showChevron={false}
                    />
                </SettingsListGroup>

                {/* Support */}
                <SettingsListGroup title={t('settings.sections.supportFeedback')}>
                    <SettingsListItem
                        icon={<RowIcon name="help-circle" />}
                        title={t('settings.supportFeedback.helpSupport')}
                        description={t('settings.supportFeedback.helpSupportDesc')}
                        onPress={() => {
                            toast(t('settings.supportFeedback.helpSupportMessage'), { type: 'info' });
                        }}
                    />
                    <SettingsListItem
                        icon={<RowIcon name="chatbubble" />}
                        title={t('settings.supportFeedback.sendFeedback')}
                        description={t('settings.supportFeedback.sendFeedbackDesc')}
                        onPress={async () => {
                            const confirmed = await confirmDialog({
                                title: t('settings.supportFeedback.sendFeedback'),
                                message: t('settings.supportFeedback.sendFeedbackMessage'),
                                okText: t('common.sendFeedback'),
                                cancelText: t('common.cancel'),
                            });
                            if (confirmed) {
                                toast(t('settings.supportFeedback.sendFeedbackThankYou'), { type: 'success' });
                            }
                        }}
                    />
                </SettingsListGroup>

                {/* Debug */}
                <SettingsListGroup title={t('settings.debug', { defaultValue: 'Debug' })}>
                    <SettingsListItem
                        icon={<RowIcon name="code-slash" />}
                        title={t('settings.systemLog', { defaultValue: 'System log' })}
                        description={t('settings.systemLogDesc', { defaultValue: 'View in-app diagnostic logs' })}
                        onPress={() => router.push('/sys/log')}
                    />
                    <SettingsListItem
                        icon={<RowIcon name="trash" destructive />}
                        title={t('settings.data.clearCache')}
                        description={t('settings.data.clearCacheDesc')}
                        onPress={handleClearCache}
                        destructive
                    />
                </SettingsListGroup>
            </ScrollView>
        </ThemedView>
    );
}
