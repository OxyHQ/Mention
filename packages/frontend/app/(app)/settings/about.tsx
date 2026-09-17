import React from 'react';
import { PageHeader } from '@oxy.so/bloom/page-header';
import { View, Text, ScrollView } from 'react-native';
import { toast } from '@oxy.so/bloom/toast';
import Constants from 'expo-constants';
import { useRouter } from 'expo-router';
import { ThemedView } from '@/components/ThemedView';
import { useSafeBack } from '@/hooks/useSafeBack';
import { LogoIcon } from '@/assets/logo';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@oxy.so/services/ui/client';
import { SettingsListGroup, SettingsListItem } from '@oxy.so/bloom/settings-list';
import { RowIcon } from '@/components/settings/RowIcon';
import { RiChat4Line, RiCodeSSlashLine, RiDeleteBinLine, RiEarthLine, RiQuestionLine, RiShieldCheckLine, RiSmartphoneLine, RiToolsFill } from '@oxy.so/bloom/icons';
import { confirmDialog, alertDialog } from '@/utils/alerts';
import { API_URL } from '@/config';

export default function AboutScreen() {
    const { t } = useTranslation();
    const router = useRouter();
    const safeBack = useSafeBack();
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

    const apiUrl = API_URL;

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
            <PageHeader title={t('settings.aboutMention.title', { defaultValue: 'About' })} onBack={() => safeBack()} backLabel={t('common.back', { defaultValue: 'Back' })} />

            <ScrollView
                className="flex-1"
                contentContainerClassName="px-screen-margin pt-4 pb-8"
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
                        icon={<RowIcon icon={RiToolsFill} />}
                        title={t('settings.aboutMention.build')}
                        value={String(runtimeVersion)}
                        showChevron={false}
                    />
                    <SettingsListItem
                        icon={<RowIcon icon={RiSmartphoneLine} />}
                        title={t('settings.aboutMention.platform')}
                        value={platformName}
                        showChevron={false}
                    />
                    <SettingsListItem
                        icon={<RowIcon icon={RiCodeSSlashLine} />}
                        title={t('settings.aboutMention.expoSDK')}
                        value={String(expoSdkVersion)}
                        showChevron={false}
                    />
                    <SettingsListItem
                        icon={<RowIcon icon={RiCodeSSlashLine} />}
                        title={t('settings.aboutMention.oxySDK')}
                        value={String(oxySdkVersion)}
                        onPress={() => showBottomSheet?.('AppInfo')}
                    />
                    <SettingsListItem
                        icon={<RowIcon icon={RiEarthLine} />}
                        title={t('settings.aboutMention.apiUrl')}
                        value={apiUrl}
                        showChevron={false}
                    />
                </SettingsListGroup>

                {/* Moderation policy, stated publicly */}
                <SettingsListGroup>
                    <SettingsListItem
                        icon={<RowIcon icon={RiShieldCheckLine} />}
                        title={t('transparency.title')}
                        description={t('transparency.list.title')}
                        onPress={() => router.push('/transparency')}
                    />
                </SettingsListGroup>

                {/* Support */}
                <SettingsListGroup title={t('settings.sections.supportFeedback')}>
                    <SettingsListItem
                        icon={<RowIcon icon={RiQuestionLine} />}
                        title={t('settings.supportFeedback.helpSupport')}
                        description={t('settings.supportFeedback.helpSupportDesc')}
                        onPress={() => {
                            toast(t('settings.supportFeedback.helpSupportMessage'), { type: 'info' });
                        }}
                    />
                    <SettingsListItem
                        icon={<RowIcon icon={RiChat4Line} />}
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
                        icon={<RowIcon icon={RiDeleteBinLine} destructive />}
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
