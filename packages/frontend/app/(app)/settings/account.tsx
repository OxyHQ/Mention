import React from 'react';
import { ScrollView } from 'react-native';
import { router } from 'expo-router';
import { ThemedView } from '@/components/ThemedView';
import { Header } from '@/components/Header';
import { IconButton } from '@/components/ui/Button';
import { BackArrowIcon } from '@/assets/icons/back-arrow-icon';
import { useAuth } from '@oxyhq/services';
import { useTheme } from '@/hooks/useTheme';
import { useTranslation } from 'react-i18next';
import { authenticatedClient } from '@/utils/api';
import { confirmDialog, alertDialog } from '@/utils/alerts';
import { SettingsItem, SettingsGroup } from '@/components/settings/SettingsItem';

export default function AccountSettingsScreen() {
    const { t } = useTranslation();
    const { user, showBottomSheet } = useAuth() as any;

    const handleExportData = async () => {
        const confirmed = await confirmDialog({
            title: t('settings.data.exportData', { defaultValue: 'Export Your Data' }),
            message: t('settings.data.exportDataMessage', { defaultValue: 'This will collect all your posts, likes, bookmarks, and settings into a JSON export.' }),
            okText: t('common.export', { defaultValue: 'Export' }),
            cancelText: t('common.cancel'),
        });
        if (!confirmed) return;

        try {
            await authenticatedClient.post('/profile/export');
            await alertDialog({
                title: t('common.success'),
                message: t('settings.data.exportDataSuccess', { defaultValue: 'Your data export has been prepared successfully.' }),
            });
        } catch (error) {
            console.error('Error exporting data:', error);
            await alertDialog({
                title: t('common.error'),
                message: t('settings.data.exportDataError', { defaultValue: 'Failed to export data. Please try again later.' }),
            });
        }
    };

    const handleResetPersonalization = async () => {
        const confirmed = await confirmDialog({
            title: t('settings.data.resetPersonalization'),
            message: t('settings.data.resetPersonalizationMessage'),
            okText: t('common.reset'),
            cancelText: t('common.cancel'),
            destructive: true,
        });
        if (!confirmed) return;

        try {
            await authenticatedClient.delete('/profile/settings/behavior');
            await alertDialog({
                title: t('common.success'),
                message: t('settings.data.resetPersonalizationSuccess'),
            });
        } catch (error) {
            console.error('Error resetting personalization:', error);
            await alertDialog({
                title: t('common.error'),
                message: t('settings.data.resetPersonalizationError'),
            });
        }
    };

    const handleDeactivateAccount = async () => {
        const confirmed = await confirmDialog({
            title: t('settings.account.deactivate', { defaultValue: 'Deactivate Account' }),
            message: t('settings.account.deactivateMessage', { defaultValue: 'This will temporarily hide your account. You can reactivate it by signing in again.' }),
            okText: t('settings.account.deactivateConfirm', { defaultValue: 'Deactivate' }),
            cancelText: t('common.cancel'),
            destructive: true,
        });
        if (!confirmed) return;
        await alertDialog({
            title: t('settings.account.contactSupport', { defaultValue: 'Contact Support' }),
            message: t('settings.account.contactSupportMessage', { defaultValue: 'To deactivate your account, please contact support at support@mention.earth' }),
        });
    };

    const handleDeleteAccount = async () => {
        const confirmed = await confirmDialog({
            title: t('settings.account.delete', { defaultValue: 'Delete Account' }),
            message: t('settings.account.deleteMessage', { defaultValue: 'This action is permanent and cannot be undone. All your data will be deleted.' }),
            okText: t('settings.account.deleteConfirm', { defaultValue: 'Delete Account' }),
            cancelText: t('common.cancel'),
            destructive: true,
        });
        if (!confirmed) return;
        await alertDialog({
            title: t('settings.account.contactSupport', { defaultValue: 'Contact Support' }),
            message: t('settings.account.contactSupportMessage', { defaultValue: 'To delete your account, please contact support at support@mention.earth' }),
        });
    };

    return (
        <ThemedView className="flex-1">
            <Header
                options={{
                    title: t('settings.account.title', { defaultValue: 'Account' }),
                    leftComponents: [
                        <IconButton variant="icon" key="back" onPress={() => router.back()}>
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
                {/* Account info */}
                <SettingsGroup title={t('settings.account.info', { defaultValue: 'Account info' })}>
                    <SettingsItem
                        icon="person"
                        title={t('settings.account.editProfile', { defaultValue: 'Edit profile' })}
                        onPress={() => showBottomSheet?.('AccountSettings')}
                    />
                    <SettingsItem
                        icon="folder-open"
                        title={t('settings.account.fileManagement', { defaultValue: 'File management' })}
                        onPress={() => showBottomSheet?.('FileManagement')}
                    />
                </SettingsGroup>

                {/* Your data */}
                <SettingsGroup title={t('settings.yourData', { defaultValue: 'Your data' })}>
                    <SettingsItem
                        icon="download-outline"
                        title={t('settings.data.requestExport', { defaultValue: 'Request data export' })}
                        subtitle={t('settings.data.requestExportDesc', { defaultValue: 'Download a copy of your posts, likes, and bookmarks' })}
                        onPress={handleExportData}
                    />
                    <SettingsItem
                        icon="refresh"
                        title={t('settings.data.resetPersonalization')}
                        subtitle={t('settings.data.resetPersonalizationDesc')}
                        onPress={handleResetPersonalization}
                        destructive
                    />
                </SettingsGroup>

                {/* Danger zone */}
                <SettingsGroup title={t('settings.account.dangerZone', { defaultValue: 'Danger zone' })}>
                    <SettingsItem
                        icon="eye-off-outline"
                        title={t('settings.account.deactivate', { defaultValue: 'Deactivate account' })}
                        subtitle={t('settings.account.deactivateDesc', { defaultValue: 'Temporarily hide your account' })}
                        onPress={handleDeactivateAccount}
                    />
                    <SettingsItem
                        icon="trash-outline"
                        title={t('settings.account.delete', { defaultValue: 'Delete account' })}
                        subtitle={t('settings.account.deleteDesc', { defaultValue: 'Permanently delete your account and all data' })}
                        onPress={handleDeleteAccount}
                        destructive
                    />
                </SettingsGroup>
            </ScrollView>
        </ThemedView>
    );
}
