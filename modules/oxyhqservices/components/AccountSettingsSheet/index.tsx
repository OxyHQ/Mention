import React, { useState, useContext } from 'react';
import {
    View,
    TouchableOpacity,
    StyleSheet,
    Switch,
    ScrollView,
    Alert,
} from 'react-native';
import { useTranslation } from 'react-i18next';
import { colors } from '@/styles/colors';
import { BaseBottomSheet } from '../BaseBottomSheet';
import { sharedStyles } from '../../styles/shared';
import { ThemedText } from '@/components/ThemedText';
import { Ionicons } from '@expo/vector-icons';
import { BottomSheetContext } from '@/context/BottomSheetContext';
import { useAuth } from '../../hooks';
import { privacyService } from '../../services/privacy.service';
import type { OxyProfile } from '../../types';

type PrivacySettings = Required<NonNullable<OxyProfile['privacySettings']>>;

interface SettingsSectionProps {
    title: string;
    children: React.ReactNode;
}

const SettingsSection = ({ title, children }: SettingsSectionProps) => (
    <View style={styles.section}>
        <ThemedText style={styles.sectionTitle}>{title}</ThemedText>
        {children}
    </View>
);

interface SettingsToggleProps {
    label: string;
    value: boolean;
    onValueChange: (value: boolean) => void;
    description?: string;
}

const SettingsToggle = ({ label, value, onValueChange, description }: SettingsToggleProps) => (
    <View style={styles.settingItem}>
        <View style={styles.settingTextContainer}>
            <ThemedText style={styles.settingLabel}>{label}</ThemedText>
            {description && (
                <ThemedText style={styles.settingDescription}>{description}</ThemedText>
            )}
        </View>
        <Switch
            value={value}
            onValueChange={onValueChange}
            trackColor={{ false: colors.COLOR_BLACK_LIGHT_6, true: colors.primaryColor }}
            thumbColor={colors.primaryLight}
        />
    </View>
);

export function AccountSettingsSheet() {
    const { t } = useTranslation();
    const { openBottomSheet } = useContext(BottomSheetContext);
    const { user } = useAuth();
    const [settings, setSettings] = useState<PrivacySettings>({
        isPrivateAccount: false,
        hideOnlineStatus: false,
        hideLastSeen: false,
        profileVisibility: true,
        postVisibility: true,
        twoFactorEnabled: false,
        loginAlerts: true,
        blockScreenshots: false,
        secureLogin: true,
        biometricLogin: false,
        showActivity: true,
        allowTagging: true,
        allowMentions: true,
        hideReadReceipts: false,
        allowComments: true,
        allowDirectMessages: true,
        dataSharing: true,
        locationSharing: false,
        analyticsSharing: true,
        sensitiveContent: false,
        autoFilter: true,
        muteKeywords: false,
    });

    const handleSettingChange = async (key: keyof PrivacySettings, value: boolean) => {
        try {
            await privacyService.updatePrivacySettings(user!.id, { [key]: value });
            setSettings(prev => ({ ...prev, [key]: value }));
        } catch (error) {
            Alert.alert(t('Error'), t('Failed to update setting'));
        }
    };

    return (
        <BaseBottomSheet
            onClose={() => openBottomSheet(false)}
            title={t('Account Settings')}
            showLogo={false}
        >
            <ScrollView style={styles.container} showsVerticalScrollIndicator={false}>
                <SettingsSection title={t('Privacy')}>
                    <SettingsToggle
                        label={t('Private Account')}
                        value={settings.isPrivateAccount}
                        onValueChange={(value) => handleSettingChange('isPrivateAccount', value)}
                        description={t('Only approved followers can see your posts')}
                    />
                    <SettingsToggle
                        label={t('Hide Online Status')}
                        value={settings.hideOnlineStatus}
                        onValueChange={(value) => handleSettingChange('hideOnlineStatus', value)}
                    />
                    <SettingsToggle
                        label={t('Hide Last Seen')}
                        value={settings.hideLastSeen}
                        onValueChange={(value) => handleSettingChange('hideLastSeen', value)}
                    />
                </SettingsSection>

                <SettingsSection title={t('Security')}>
                    <SettingsToggle
                        label={t('Two-Factor Authentication')}
                        value={settings.twoFactorEnabled}
                        onValueChange={(value) => handleSettingChange('twoFactorEnabled', value)}
                        description={t('Add an extra layer of security to your account')}
                    />
                    <SettingsToggle
                        label={t('Login Alerts')}
                        value={settings.loginAlerts}
                        onValueChange={(value) => handleSettingChange('loginAlerts', value)}
                    />
                    <SettingsToggle
                        label={t('Block Screenshots')}
                        value={settings.blockScreenshots}
                        onValueChange={(value) => handleSettingChange('blockScreenshots', value)}
                    />
                    <SettingsToggle
                        label={t('Biometric Login')}
                        value={settings.biometricLogin}
                        onValueChange={(value) => handleSettingChange('biometricLogin', value)}
                    />
                </SettingsSection>

                <SettingsSection title={t('Interactions')}>
                    <SettingsToggle
                        label={t('Show Activity Status')}
                        value={settings.showActivity}
                        onValueChange={(value) => handleSettingChange('showActivity', value)}
                    />
                    <SettingsToggle
                        label={t('Allow Tagging')}
                        value={settings.allowTagging}
                        onValueChange={(value) => handleSettingChange('allowTagging', value)}
                    />
                    <SettingsToggle
                        label={t('Allow Mentions')}
                        value={settings.allowMentions}
                        onValueChange={(value) => handleSettingChange('allowMentions', value)}
                    />
                    <SettingsToggle
                        label={t('Hide Read Receipts')}
                        value={settings.hideReadReceipts}
                        onValueChange={(value) => handleSettingChange('hideReadReceipts', value)}
                    />
                    <SettingsToggle
                        label={t('Allow Comments')}
                        value={settings.allowComments}
                        onValueChange={(value) => handleSettingChange('allowComments', value)}
                    />
                    <SettingsToggle
                        label={t('Allow Direct Messages')}
                        value={settings.allowDirectMessages}
                        onValueChange={(value) => handleSettingChange('allowDirectMessages', value)}
                    />
                </SettingsSection>

                <SettingsSection title={t('Data & Privacy')}>
                    <SettingsToggle
                        label={t('Data Sharing')}
                        value={settings.dataSharing}
                        onValueChange={(value) => handleSettingChange('dataSharing', value)}
                        description={t('Share usage data to improve our services')}
                    />
                    <SettingsToggle
                        label={t('Location Sharing')}
                        value={settings.locationSharing}
                        onValueChange={(value) => handleSettingChange('locationSharing', value)}
                    />
                    <SettingsToggle
                        label={t('Analytics Sharing')}
                        value={settings.analyticsSharing}
                        onValueChange={(value) => handleSettingChange('analyticsSharing', value)}
                    />
                </SettingsSection>

                <SettingsSection title={t('Content')}>
                    <SettingsToggle
                        label={t('Show Sensitive Content')}
                        value={settings.sensitiveContent}
                        onValueChange={(value) => handleSettingChange('sensitiveContent', value)}
                    />
                    <SettingsToggle
                        label={t('Auto-Filter Content')}
                        value={settings.autoFilter}
                        onValueChange={(value) => handleSettingChange('autoFilter', value)}
                    />
                    <SettingsToggle
                        label={t('Mute Keywords')}
                        value={settings.muteKeywords}
                        onValueChange={(value) => handleSettingChange('muteKeywords', value)}
                    />
                </SettingsSection>
            </ScrollView>
        </BaseBottomSheet>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        paddingHorizontal: 16,
    },
    section: {
        marginBottom: 24,
    },
    sectionTitle: {
        fontSize: 20,
        fontWeight: '600',
        marginBottom: 16,
        color: colors.COLOR_BLACK,
    },
    settingItem: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        paddingVertical: 12,
        borderBottomWidth: 1,
        borderBottomColor: colors.COLOR_BLACK_LIGHT_8,
    },
    settingTextContainer: {
        flex: 1,
        marginRight: 16,
    },
    settingLabel: {
        fontSize: 16,
        color: colors.COLOR_BLACK,
    },
    settingDescription: {
        fontSize: 14,
        color: colors.COLOR_BLACK_LIGHT_4,
        marginTop: 4,
    },
}); 