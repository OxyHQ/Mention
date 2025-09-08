import { useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Alert, Switch } from 'react-native';
import { ThemedView } from '@/components/ThemedView';
import { useOxy } from '@oxyhq/services';
import { useTranslation } from 'react-i18next';

import { Ionicons } from '@expo/vector-icons';
import Constants from 'expo-constants';
import { useRouter } from 'expo-router';
import { colors } from '../../styles/colors';
import { LogoIcon } from '../../assets/logo';

// Type assertion for Ionicons compatibility with React 19
const IconComponent = Ionicons as any;

export default function SettingsScreen() {
    const { t } = useTranslation();
    const router = useRouter();
    const { user, showBottomSheet } = useOxy();

    // Determine Expo SDK/version information with safe fallbacks
    const expoSdkVersion =
        // Newer Expo exposes sdkVersion in expoConfig or manifest
        (Constants.expoConfig && (Constants.expoConfig.sdkVersion || Constants.expoConfig.runtimeVersion)) ||
        // Older Expo versions may have manifest.sdkVersion
        (Constants.manifest && (Constants.manifest.sdkVersion || Constants.manifest.releaseChannel)) ||
        // Expo runtime/version fields
        Constants.expoRuntimeVersion || Constants.expoVersion ||
        // final fallback
        'Unknown';

    // Determine Oxy SDK version from known locations (Constants, expoConfig extras, manifest extras, or oxyServices)
    const oxySdkVersion =
        Constants.oxyVersion ||
        (Constants.expoConfig &&
            (Constants.expoConfig.extra?.oxyVersion || Constants.expoConfig.extra?.oxySDKVersion)) ||
        (Constants.manifest &&
            (Constants.manifest.extra?.oxyVersion || Constants.manifest.extra?.oxySDKVersion)) ||
        // (No oxyServices fallback here; prefer build-time constants and manifest extras)
        'Unknown';

    // Determine API URL from build/runtime config or environment fallbacks
    const apiUrl = process.env.EXPO_PUBLIC_API_URL || process.env.API_URL ||
        // final fallback
        'Not set';

    // Settings state
    const [notifications, setNotifications] = useState(true);
    const [darkMode, setDarkMode] = useState(false);
    const [autoSync, setAutoSync] = useState(true);
    const [offlineMode, setOfflineMode] = useState(false);

    const handleSignOut = () => {
        Alert.alert(t('settings.signOut'), t('settings.signOutMessage'), [
            {
                text: t('common.cancel'),
                style: 'cancel',
            },
            {
                text: t('settings.signOut'),
                style: 'destructive',
                onPress: () => {
                    // For now, just navigate back - the actual sign out would depend on your auth system
                    router.replace('/');
                },
            },
        ]);
    };

    const handleClearCache = () => {
        Alert.alert(t('settings.data.clearCache'), t('settings.data.clearCacheMessage'), [
            {
                text: t('common.cancel'),
                style: 'cancel',
            },
            {
                text: t('common.clear'),
                style: 'destructive',
                onPress: () => {
                    // Implementation would clear app cache
                    Alert.alert(t('common.success'), t('settings.data.clearCacheSuccess'));
                },
            },
        ]);
    };

    const handleExportData = () => {
        Alert.alert(t('settings.data.exportData'), t('settings.data.exportDataMessage'), [
            { text: t('common.cancel'), style: 'cancel' },
            {
                text: t('common.export'),
                onPress: () => {
                    Alert.alert(t('common.success'), t('settings.data.exportDataSuccess'));
                },
            },
        ]);
    };

    return (
        <ThemedView style={styles.container}>
            {/* Header */}
            <View style={styles.header}>
                <Text style={styles.headerTitle}>{t('settings.title')}</Text>
            </View>

            <View style={styles.content}>
                {/* User Info */}
                <View style={styles.section}>
                    <Text style={styles.sectionTitle}>{t('settings.sections.account')}</Text>

                    <TouchableOpacity
                        style={[styles.settingItem, styles.firstSettingItem, styles.lastSettingItem]}
                        onPress={() => showBottomSheet?.('AccountSettings')}
                    >
                        <View style={styles.userIcon}>
                            <IconComponent name="person" size={24} color="#fff" />
                        </View>
                        <View style={styles.settingInfo}>
                            <View>
                                <Text style={styles.settingLabel}>
                                    {user
                                        ? typeof user.name === 'string'
                                            ? user.name
                                            : user.name?.full || user.name?.first || user.username
                                        : 'User'}
                                </Text>
                                <Text style={styles.settingDescription}>{user?.username || 'Username'}</Text>
                            </View>
                        </View>
                        <IconComponent name="chevron-forward" size={16} color="#ccc" />
                    </TouchableOpacity>
                    <TouchableOpacity
                        style={[styles.settingItem, styles.firstSettingItem, styles.lastSettingItem]}
                        onPress={() => showBottomSheet?.('FileManagement')}
                    >
                        <View style={styles.userIcon}>
                            <IconComponent name="person" size={24} color="#fff" />
                        </View>
                        <View style={styles.settingInfo}>
                            <View>
                                <Text style={styles.settingLabel}>
                                    {user
                                        ? typeof user.name === 'string'
                                            ? user.name
                                            : user.name?.full || user.name?.first || user.username
                                        : 'User'}
                                </Text>
                                <Text style={styles.settingDescription}>{user?.username || 'Username'}</Text>
                            </View>
                        </View>
                        <IconComponent name="chevron-forward" size={16} color="#ccc" />
                    </TouchableOpacity>
                </View>

                {/* About Mention */}
                <View style={styles.section}>
                    <Text style={styles.sectionTitle}>{t('settings.sections.aboutMention')}</Text>

                    {/* App Title and Version */}
                    <View style={[styles.settingItem, styles.firstSettingItem]}>
                        <View style={styles.settingInfo}>
                            <LogoIcon size={24} color={colors.primaryColor} style={styles.settingIcon} />
                            <View>
                                <Text style={styles.settingLabel}>{t('settings.aboutMention.appName')}</Text>
                                <Text style={styles.settingDescription}>
                                    {t('settings.aboutMention.version', {
                                        version: Constants.expoConfig?.version || '1.0.0',
                                    })}
                                </Text>
                            </View>
                        </View>
                    </View>

                    {/* Build Info */}
                    <View style={styles.settingItem}>
                        <View style={styles.settingInfo}>
                            <IconComponent name="hammer" size={20} color="#666" style={styles.settingIcon} />
                            <View>
                                <Text style={styles.settingLabel}>{t('settings.aboutMention.build')}</Text>
                                <Text style={styles.settingDescription}>
                                    {typeof Constants.expoConfig?.runtimeVersion === 'string'
                                        ? Constants.expoConfig.runtimeVersion
                                        : t('settings.aboutMention.buildVersion')}
                                </Text>
                            </View>
                        </View>
                    </View>

                    {/* Platform Info */}
                    <View style={styles.settingItem}>
                        <View style={styles.settingInfo}>
                            <IconComponent
                                name="phone-portrait"
                                size={20}
                                color="#666"
                                style={styles.settingIcon}
                            />
                            <View>
                                <Text style={styles.settingLabel}>{t('settings.aboutMention.platform')}</Text>
                                <Text style={styles.settingDescription}>
                                    {Constants.platform?.ios
                                        ? 'iOS'
                                        : Constants.platform?.android
                                            ? 'Android'
                                            : 'Web'}
                                </Text>
                            </View>
                        </View>
                    </View>

                    {/* Oxy SDK */}
                    <TouchableOpacity style={styles.settingItem} onPress={() => showBottomSheet?.('AppInfo')}>
                        <View style={styles.settingInfo}>
                            <IconComponent name="code-slash" size={20} color="#666" style={styles.settingIcon} />
                            <View>
                                <Text style={styles.settingLabel}>{t('settings.aboutMention.oxySDK')}</Text>
                                <Text style={styles.settingDescription}>{oxySdkVersion}</Text>
                            </View>
                        </View>
                    </TouchableOpacity>

                    {/* Expo SDK */}
                    <View style={[styles.settingItem]}>
                        <View style={styles.settingInfo}>
                            <IconComponent name="code-slash" size={20} color="#666" style={styles.settingIcon} />
                            <View>
                                <Text style={styles.settingLabel}>{t('settings.aboutMention.expoSDK')}</Text>
                                <Text style={styles.settingDescription}>{expoSdkVersion}</Text>
                            </View>
                        </View>
                    </View>

                    {/* API URL (from env/config) */}
                    <View style={[styles.settingItem, styles.lastSettingItem]}>
                        <View style={styles.settingInfo}>
                            <IconComponent name="globe" size={20} color="#666" style={styles.settingIcon} />
                            <View>
                                <Text style={styles.settingLabel}>{t('settings.aboutMention.apiUrl')}</Text>
                                <Text style={styles.settingDescription}>{apiUrl}</Text>
                            </View>
                        </View>
                    </View>
                </View>

                {/* Support & Feedback */}
                <View style={styles.section}>
                    <Text style={styles.sectionTitle}>{t('settings.sections.supportFeedback')}</Text>

                    <TouchableOpacity
                        style={[styles.settingItem, styles.firstSettingItem]}
                        onPress={() => {
                            Alert.alert(
                                t('settings.supportFeedback.helpSupport'),
                                t('settings.supportFeedback.helpSupportMessage'),
                                [{ text: t('common.ok') }],
                            );
                        }}
                    >
                        <View style={styles.settingInfo}>
                            <IconComponent name="help-circle" size={20} color="#666" style={styles.settingIcon} />
                            <View>
                                <Text style={styles.settingLabel}>{t('settings.supportFeedback.helpSupport')}</Text>
                                <Text style={styles.settingDescription}>
                                    {t('settings.supportFeedback.helpSupportDesc')}
                                </Text>
                            </View>
                        </View>
                        <IconComponent name="chevron-forward" size={16} color="#ccc" />
                    </TouchableOpacity>

                    <TouchableOpacity
                        style={styles.settingItem}
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
                    >
                        <View style={styles.settingInfo}>
                            <IconComponent name="chatbubble" size={20} color="#666" style={styles.settingIcon} />
                            <View>
                                <Text style={styles.settingLabel}>
                                    {t('settings.supportFeedback.sendFeedback')}
                                </Text>
                                <Text style={styles.settingDescription}>
                                    {t('settings.supportFeedback.sendFeedbackDesc')}
                                </Text>
                            </View>
                        </View>
                        <IconComponent name="chevron-forward" size={16} color="#ccc" />
                    </TouchableOpacity>

                    <TouchableOpacity
                        style={[styles.settingItem, styles.lastSettingItem]}
                        onPress={() => {
                            Alert.alert(
                                t('settings.supportFeedback.rateApp'),
                                t('settings.supportFeedback.rateAppMessage'),
                                [
                                    { text: t('common.maybeLater'), style: 'cancel' },
                                    {
                                        text: t('common.rateNow'),
                                        onPress: () => {
                                            Alert.alert(
                                                t('common.success'),
                                                t('settings.supportFeedback.rateAppThankYou'),
                                            );
                                        },
                                    },
                                ],
                            );
                        }}
                    >
                        <View style={styles.settingInfo}>
                            <IconComponent name="star" size={20} color="#666" style={styles.settingIcon} />
                            <View>
                                <Text style={styles.settingLabel}>{t('settings.supportFeedback.rateApp')}</Text>
                                <Text style={styles.settingDescription}>
                                    {t('settings.supportFeedback.rateAppDesc')}
                                </Text>
                            </View>
                        </View>
                        <IconComponent name="chevron-forward" size={16} color="#ccc" />
                    </TouchableOpacity>
                </View>

                {/* App Preferences */}
                <View style={styles.section}>
                    <Text style={styles.sectionTitle}>{t('settings.sections.preferences')}</Text>

                    {/* Language Selection */}
                    <TouchableOpacity
                        style={[styles.settingItem, styles.firstSettingItem]}
                        onPress={() => router.push('/settings/language')}
                    >
                        <View style={styles.settingInfo}>
                            <IconComponent name="language" size={20} color="#666" style={styles.settingIcon} />
                            <View>
                                <Text style={styles.settingLabel}>{t('Language')}</Text>
                                <Text style={styles.settingDescription}>{t('Select your preferred language')}</Text>
                            </View>
                        </View>
                        <IconComponent name="chevron-forward" size={16} color="#ccc" />
                    </TouchableOpacity>

                    <View style={styles.settingItem}>
                        <View style={styles.settingInfo}>
                            <IconComponent
                                name="notifications"
                                size={20}
                                color="#666"
                                style={styles.settingIcon}
                            />
                            <View>
                                <Text style={styles.settingLabel}>{t('settings.preferences.notifications')}</Text>
                                <Text style={styles.settingDescription}>
                                    {t('settings.preferences.notificationsDesc')}
                                </Text>
                            </View>
                        </View>
                        <Switch
                            value={notifications}
                            onValueChange={setNotifications}
                            trackColor={{ false: '#f0f0f0', true: colors.primaryColor }}
                            thumbColor={notifications ? '#ffffff' : '#d1d5db'}
                            ios_backgroundColor="#f0f0f0"
                        />
                    </View>

                    <View style={styles.settingItem}>
                        <View style={styles.settingInfo}>
                            <IconComponent name="moon" size={20} color="#666" style={styles.settingIcon} />
                            <View>
                                <Text style={styles.settingLabel}>{t('settings.preferences.darkMode')}</Text>
                                <Text style={styles.settingDescription}>
                                    {t('settings.preferences.darkModeDesc')}
                                </Text>
                            </View>
                        </View>
                        <Switch
                            value={darkMode}
                            onValueChange={setDarkMode}
                            trackColor={{ false: '#f0f0f0', true: colors.primaryColor }}
                            thumbColor={darkMode ? '#ffffff' : '#d1d5db'}
                            ios_backgroundColor="#f0f0f0"
                        />
                    </View>

                    <View style={styles.settingItem}>
                        <View style={styles.settingInfo}>
                            <IconComponent name="sync" size={20} color="#666" style={styles.settingIcon} />
                            <View>
                                <Text style={styles.settingLabel}>{t('settings.preferences.autoSync')}</Text>
                                <Text style={styles.settingDescription}>
                                    {t('settings.preferences.autoSyncDesc')}
                                </Text>
                            </View>
                        </View>
                        <Switch
                            value={autoSync}
                            onValueChange={setAutoSync}
                            trackColor={{ false: '#f0f0f0', true: colors.primaryColor }}
                            thumbColor={autoSync ? '#ffffff' : '#d1d5db'}
                            ios_backgroundColor="#f0f0f0"
                        />
                    </View>

                    <View style={[styles.settingItem, styles.lastSettingItem]}>
                        <View style={styles.settingInfo}>
                            <IconComponent
                                name="cloud-offline"
                                size={20}
                                color="#666"
                                style={styles.settingIcon}
                            />
                            <View>
                                <Text style={styles.settingLabel}>{t('settings.preferences.offlineMode')}</Text>
                                <Text style={styles.settingDescription}>
                                    {t('settings.preferences.offlineModeDesc')}
                                </Text>
                            </View>
                        </View>
                        <Switch
                            value={offlineMode}
                            onValueChange={setOfflineMode}
                            trackColor={{ false: '#f0f0f0', true: colors.primaryColor }}
                            thumbColor={offlineMode ? '#ffffff' : '#d1d5db'}
                            ios_backgroundColor="#f0f0f0"
                        />
                    </View>
                </View>

                {/* Quick Actions */}
                <View style={styles.section}>
                    <Text style={styles.sectionTitle}>{t('settings.sections.quickActions')}</Text>

                    <TouchableOpacity
                        style={[styles.settingItem, styles.firstSettingItem]}
                        onPress={() => router.push('/properties/create')}
                    >
                        <View style={styles.settingInfo}>
                            <IconComponent name="add" size={20} color="#666" style={styles.settingIcon} />
                            <View>
                                <Text style={styles.settingLabel}>{t('settings.quickActions.createProperty')}</Text>
                                <Text style={styles.settingDescription}>
                                    {t('settings.quickActions.createPropertyDesc')}
                                </Text>
                            </View>
                        </View>
                        <IconComponent name="chevron-forward" size={16} color="#ccc" />
                    </TouchableOpacity>

                    <TouchableOpacity
                        style={[styles.settingItem, styles.lastSettingItem]}
                        onPress={() => router.push('/search')}
                    >
                        <View style={styles.settingInfo}>
                            <IconComponent name="search" size={20} color="#666" style={styles.settingIcon} />
                            <View>
                                <Text style={styles.settingLabel}>
                                    {t('settings.quickActions.searchProperties')}
                                </Text>
                                <Text style={styles.settingDescription}>
                                    {t('settings.quickActions.searchPropertiesDesc')}
                                </Text>
                            </View>
                        </View>
                        <IconComponent name="chevron-forward" size={16} color="#ccc" />
                    </TouchableOpacity>
                </View>

                {/* Data Management */}
                <View style={styles.section}>
                    <Text style={styles.sectionTitle}>{t('settings.sections.data')}</Text>

                    <TouchableOpacity
                        style={[styles.settingItem, styles.firstSettingItem]}
                        onPress={handleExportData}
                    >
                        <View style={styles.settingInfo}>
                            <IconComponent name="download" size={20} color="#666" style={styles.settingIcon} />
                            <View>
                                <Text style={styles.settingLabel}>{t('settings.data.exportData')}</Text>
                                <Text style={styles.settingDescription}>{t('settings.data.exportDataDesc')}</Text>
                            </View>
                        </View>
                        <IconComponent name="chevron-forward" size={16} color="#ccc" />
                    </TouchableOpacity>

                    <TouchableOpacity
                        style={[styles.settingItem, styles.lastSettingItem]}
                        onPress={handleClearCache}
                    >
                        <View style={styles.settingInfo}>
                            <IconComponent name="trash" size={20} color="#ff4757" style={styles.settingIcon} />
                            <View>
                                <Text style={[styles.settingLabel, { color: '#ff4757' }]}>
                                    {t('settings.data.clearCache')}
                                </Text>
                                <Text style={styles.settingDescription}>{t('settings.data.clearCacheDesc')}</Text>
                            </View>
                        </View>
                        <IconComponent name="chevron-forward" size={16} color="#ccc" />
                    </TouchableOpacity>
                </View>

                {/* Sign Out */}
                <View style={styles.section}>
                    <TouchableOpacity
                        style={[
                            styles.settingItem,
                            styles.firstSettingItem,
                            styles.lastSettingItem,
                            styles.signOutButton,
                        ]}
                        onPress={handleSignOut}
                    >
                        <View style={styles.settingInfo}>
                            <IconComponent name="log-out" size={20} color="#ff4757" style={styles.settingIcon} />
                            <View>
                                <Text style={[styles.settingLabel, { color: '#ff4757' }]}>
                                    {t('settings.signOut')}
                                </Text>
                                <Text style={styles.settingDescription}>{t('settings.signOutDesc')}</Text>
                            </View>
                        </View>
                    </TouchableOpacity>
                </View>
            </View>
    </ThemedView>
    );
}

const styles = StyleSheet.create({
    container: {
    flex: 1,
    },
    header: {
        paddingHorizontal: 20,
        paddingTop: 20,
        paddingBottom: 16,
    backgroundColor: colors.primaryLight,
        borderBottomWidth: 1,
        borderBottomColor: '#e0e0e0',
    },
    headerTitle: {
        fontSize: 24,
        fontWeight: 'bold',
        color: '#000',
    },
    content: {
        padding: 16,
    },
    userIcon: {
        width: 40,
        height: 40,
        borderRadius: 20,
        backgroundColor: colors.primaryColor,
        alignItems: 'center',
        justifyContent: 'center',
        marginRight: 12,
    },
    section: {
        marginBottom: 24,
    },
    sectionTitle: {
        fontSize: 16,
        fontWeight: '600',
        color: '#333',
        marginBottom: 12,
    },
    settingItem: {
        backgroundColor: colors.primaryLight,
        padding: 16,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginBottom: 2,
    },
    firstSettingItem: {
        borderTopLeftRadius: 24,
        borderTopRightRadius: 24,
        marginBottom: 2,
    },
    lastSettingItem: {
        borderBottomLeftRadius: 24,
        borderBottomRightRadius: 24,
        marginBottom: 8,
    },
    settingInfo: {
        flexDirection: 'row',
        alignItems: 'center',
        flex: 1,
    },
    settingIcon: {
        marginRight: 12,
    },
    settingLabel: {
        fontSize: 16,
        fontWeight: '500',
        color: '#333',
        marginBottom: 2,
    },
    settingDescription: {
        fontSize: 14,
        color: '#666',
    },
    signOutButton: {
        borderWidth: 1,
        borderColor: '#ff4757',
    },
});
