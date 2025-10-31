import { useCallback, useEffect, useState, useRef, useMemo } from "react";
import { View, Text, TouchableOpacity, StyleSheet, Alert, Switch, Platform, ScrollView, Animated } from "react-native";
import { ThemedView } from "@/components/ThemedView";
import { Header } from "@/components/Header";
import { useOxy } from "@oxyhq/services";
import { useTranslation } from "react-i18next";
import { useLayoutScroll } from "@/context/LayoutScrollContext";

import { Ionicons } from "@expo/vector-icons";
import Constants from "expo-constants";
import { useRouter } from "expo-router";
import { LogoIcon } from "../../assets/logo";
import { authenticatedClient } from "@/utils/api";
import { confirmDialog, alertDialog } from "@/utils/alerts";
import { getData, storeData } from "@/utils/storage";
// (already imported above)
import { hasNotificationPermission, requestNotificationPermissions, getDevicePushToken } from "@/utils/notifications";
import { useTheme } from "@/hooks/useTheme";
import { getThemedBorder, getThemedShadow } from "@/utils/theme";

// Type assertion for Ionicons compatibility with React 19
const IconComponent = Ionicons as any;

export default function SettingsScreen() {
    const { t } = useTranslation();
    const router = useRouter();
    const { user, showBottomSheet } = useOxy();
    const theme = useTheme();
    const scrollViewRef = useRef<ScrollView>(null);
    const unregisterScrollableRef = useRef<(() => void) | null>(null);
    const { handleScroll, scrollEventThrottle, registerScrollable, forwardWheelEvent, createAnimatedScrollHandler } = useLayoutScroll();

    const clearScrollRegistration = useCallback(() => {
        if (unregisterScrollableRef.current) {
            unregisterScrollableRef.current();
            unregisterScrollableRef.current = null;
        }
    }, []);

    const assignScrollViewRef = useCallback((node: any) => {
        scrollViewRef.current = node;
        clearScrollRegistration();
        if (node && registerScrollable) {
            unregisterScrollableRef.current = registerScrollable(node);
        }
    }, [clearScrollRegistration, registerScrollable]);

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
    const unregisterPushToken = useCallback(async () => {
        try {
            const tokenInfo = await getDevicePushToken();
            if (!tokenInfo?.token) return;
            await authenticatedClient.delete('/notifications/push-token', { data: { token: tokenInfo.token } });
        } catch (e) {
            console.warn('Failed to unregister push token:', e);
        }
    }, []);

    const registerPushIfPermitted = useCallback(async () => {
        if (Constants.appOwnership === 'expo') {
            console.warn('expo-notifications: Remote push is unavailable in Expo Go. Use a development build.');
            return false;
        }
        const granted = await hasNotificationPermission() || await requestNotificationPermissions();
        if (!granted) return false;
        try {
            const tokenInfo = await getDevicePushToken();
            if (!tokenInfo?.token) return false;
            await authenticatedClient.post('/notifications/push-token', {
                token: tokenInfo.token,
                type: tokenInfo.type || (Platform.OS === 'ios' ? 'apns' : 'fcm'),
                platform: Platform.OS,
                locale: (Constants as any).locale || 'en-US',
            });
            return true;
        } catch (e) {
            console.warn('Failed to (re)register push token:', e);
            return false;
        }
    }, []);

    const onToggleNotifications = useCallback(async (value: boolean) => {
        setNotifications(value);
        const storageKey = `pref:${user?.id || 'global'}:notificationsEnabled`;
        await storeData(storageKey, value);
        if (value) {
            await registerPushIfPermitted();
        } else {
            await unregisterPushToken();
        }
    }, [registerPushIfPermitted, unregisterPushToken, user?.id]);

    // Load initial notifications toggle from storage
    useEffect(() => {
        let mounted = true;
        const load = async () => {
            const storageKey = `pref:${user?.id || 'global'}:notificationsEnabled`;
            const saved = await getData<boolean>(storageKey);
            if (!mounted) return;
            if (typeof saved === 'boolean') {
                setNotifications(saved);
            }
        };
        load();
        return () => { mounted = false; };
    }, [user?.id]);

    useEffect(() => {
        return () => {
            clearScrollRegistration();
        };
    }, [clearScrollRegistration]);

    const onScroll = useMemo(
        () => createAnimatedScrollHandler(handleScroll),
        [createAnimatedScrollHandler, handleScroll]
    );

    // Handle wheel events for web
    const handleWheelEvent = useCallback((event: any) => {
        if (forwardWheelEvent) {
            forwardWheelEvent(event);
        }
    }, [forwardWheelEvent]);
    const [darkMode, setDarkMode] = useState(false);
    const [autoSync, setAutoSync] = useState(true);
    const [offlineMode, setOfflineMode] = useState(false);

    const handleSignOut = async () => {
        const confirmed = await confirmDialog({
            title: t('settings.signOut'),
            message: t('settings.signOutMessage'),
            okText: t('settings.signOut'),
            cancelText: t('common.cancel'),
            destructive: true,
        });
        if (!confirmed) return;
        // For now, just navigate back - the actual sign out would depend on your auth system
        router.replace('/');
    };

    const handleClearCache = async () => {
        const confirmed = await confirmDialog({
            title: t('settings.data.clearCache'),
            message: t('settings.data.clearCacheMessage'),
            okText: t('common.clear'),
            cancelText: t('common.cancel'),
            destructive: true,
        });
        if (!confirmed) return;
        // Implementation would clear app cache
        await alertDialog({ title: t('common.success'), message: t('settings.data.clearCacheSuccess') });
    };

    const handleExportData = async () => {
        const confirmed = await confirmDialog({
            title: t('settings.data.exportData'),
            message: t('settings.data.exportDataMessage'),
            okText: t('common.export'),
            cancelText: t('common.cancel'),
        });
        if (!confirmed) return;
        await alertDialog({ title: t('common.success'), message: t('settings.data.exportDataSuccess') });
    };

    return (
        <ThemedView style={styles.container}>
            {/* Header */}
            <Header
                options={{
                    title: t("settings.title"),
                    showBackButton: true,
                }}
                hideBottomBorder={false}
            />

            <Animated.ScrollView
                ref={assignScrollViewRef}
                style={styles.scrollView}
                contentContainerStyle={styles.content}
                showsVerticalScrollIndicator={false}
                onScroll={onScroll}
                scrollEventThrottle={scrollEventThrottle}
                {...(Platform.OS === 'web' ? { dataSet: { layoutscroll: 'true' } } : {}) as any}
            >
                {/* User Info */}
                <View style={styles.section}>
                    <Text style={[styles.sectionTitle, { color: theme.colors.text }]}>{t("settings.sections.account")}</Text>

                    <TouchableOpacity
                        style={[styles.settingItem, styles.firstSettingItem, styles.lastSettingItem, { backgroundColor: theme.colors.card }]}
                        onPress={() => showBottomSheet?.("AccountSettings")}
                    >
                        <View style={[styles.userIcon, { backgroundColor: theme.colors.primary }]}>
                            <IconComponent name="person" size={24} color={theme.colors.card} />
                        </View>
                        <View style={styles.settingInfo}>
                            <View>
                                <Text style={[styles.settingLabel, { color: theme.colors.text }]}>
                                    {user
                                        ? typeof user.name === 'string'
                                            ? user.name
                                            : user.name?.full || user.name?.first || user.username
                                        : 'User'}
                                </Text>
                                <Text style={[styles.settingDescription, { color: theme.colors.textSecondary }]}>{user?.username || 'Username'}</Text>
                            </View>
                        </View>
                        <IconComponent name="chevron-forward" size={16} color={theme.colors.textTertiary} />
                    </TouchableOpacity>
                    <TouchableOpacity
                        style={[styles.settingItem, styles.firstSettingItem, styles.lastSettingItem, { backgroundColor: theme.colors.card }]}
                        onPress={() => showBottomSheet?.("FileManagement")}
                    >
                        <View style={[styles.userIcon, { backgroundColor: theme.colors.primary }]}>
                            <IconComponent name="person" size={24} color={theme.colors.card} />
                        </View>
                        <View style={styles.settingInfo}>
                            <View>
                                <Text style={[styles.settingLabel, { color: theme.colors.text }]}>
                                    {user
                                        ? typeof user.name === 'string'
                                            ? user.name
                                            : user.name?.full || user.name?.first || user.username
                                        : 'User'}
                                </Text>
                                <Text style={[styles.settingDescription, { color: theme.colors.textSecondary }]}>{user?.username || 'Username'}</Text>
                            </View>
                        </View>
                        <IconComponent name="chevron-forward" size={16} color={theme.colors.textTertiary} />
                    </TouchableOpacity>
                </View>

                {/* About Mention */}
                <View style={styles.section}>
                    <Text style={[styles.sectionTitle, { color: theme.colors.text }]}>{t('settings.sections.aboutMention')}</Text>

                    {/* App Title and Version */}
                    <View style={[styles.settingItem, styles.firstSettingItem, { backgroundColor: theme.colors.card }]}>
                        <View style={styles.settingInfo}>
                            <LogoIcon size={24} color={theme.colors.primary} style={styles.settingIcon} />
                            <View>
                                <Text style={[styles.settingLabel, { color: theme.colors.text }]}>{t('settings.aboutMention.appName')}</Text>
                                <Text style={[styles.settingDescription, { color: theme.colors.textSecondary }]}>
                                    {t('settings.aboutMention.version', {
                                        version: Constants.expoConfig?.version || '1.0.0',
                                    })}
                                </Text>
                            </View>
                        </View>
                    </View>

                    {/* Build Info */}
                    <View style={[styles.settingItem, { backgroundColor: theme.colors.card }]}>
                        <View style={styles.settingInfo}>
                            <IconComponent name="hammer" size={20} color={theme.colors.textSecondary} style={styles.settingIcon} />
                            <View>
                                <Text style={[styles.settingLabel, { color: theme.colors.text }]}>{t('settings.aboutMention.build')}</Text>
                                <Text style={[styles.settingDescription, { color: theme.colors.textSecondary }]}>
                                    {typeof Constants.expoConfig?.runtimeVersion === 'string'
                                        ? Constants.expoConfig.runtimeVersion
                                        : t('settings.aboutMention.buildVersion')}
                                </Text>
                            </View>
                        </View>
                    </View>

                    {/* Platform Info */}
                    <View style={[styles.settingItem, { backgroundColor: theme.colors.card }]}>
                        <View style={styles.settingInfo}>
                            <IconComponent
                                name="phone-portrait"
                                size={20}
                                color={theme.colors.textSecondary}
                                style={styles.settingIcon}
                            />
                            <View>
                                <Text style={[styles.settingLabel, { color: theme.colors.text }]}>{t('settings.aboutMention.platform')}</Text>
                                <Text style={[styles.settingDescription, { color: theme.colors.textSecondary }]}>
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
                    <TouchableOpacity style={[styles.settingItem, { backgroundColor: theme.colors.card }]} onPress={() => showBottomSheet?.('AppInfo')}>
                        <View style={styles.settingInfo}>
                            <IconComponent name="code-slash" size={20} color={theme.colors.textSecondary} style={styles.settingIcon} />
                            <View>
                                <Text style={[styles.settingLabel, { color: theme.colors.text }]}>{t('settings.aboutMention.oxySDK')}</Text>
                                <Text style={[styles.settingDescription, { color: theme.colors.textSecondary }]}>{oxySdkVersion}</Text>
                            </View>
                        </View>
                    </TouchableOpacity>

                    {/* Expo SDK */}
                    <View style={[styles.settingItem]}>
                        <View style={styles.settingInfo}>
                            <IconComponent name="code-slash" size={20} color={theme.colors.textSecondary} style={styles.settingIcon} />
                            <View>
                                <Text style={[styles.settingLabel, { color: theme.colors.text }]}>{t('settings.aboutMention.expoSDK')}</Text>
                                <Text style={[styles.settingDescription, { color: theme.colors.textSecondary }]}>{expoSdkVersion}</Text>
                            </View>
                        </View>
                    </View>

                    {/* API URL (from env/config) */}
                    <View style={[styles.settingItem, styles.lastSettingItem, { backgroundColor: theme.colors.card }]}>
                        <View style={styles.settingInfo}>
                            <IconComponent name="globe" size={20} color={theme.colors.textSecondary} style={styles.settingIcon} />
                            <View>
                                <Text style={[styles.settingLabel, { color: theme.colors.text }]}>{t('settings.aboutMention.apiUrl')}</Text>
                                <Text style={[styles.settingDescription, { color: theme.colors.textSecondary }]}>{apiUrl}</Text>
                            </View>
                        </View>
                    </View>
                </View>

                {/* Support & Feedback */}
                <View style={styles.section}>
                    <Text style={[styles.sectionTitle, { color: theme.colors.text }]}>{t('settings.sections.supportFeedback')}</Text>

                    <TouchableOpacity
                        style={[styles.settingItem, styles.firstSettingItem, { backgroundColor: theme.colors.card }]}
                        onPress={() => {
                            Alert.alert(
                                t('settings.supportFeedback.helpSupport'),
                                t('settings.supportFeedback.helpSupportMessage'),
                                [{ text: t('common.ok') }],
                            );
                        }}
                    >
                        <View style={styles.settingInfo}>
                            <IconComponent name="help-circle" size={20} color={theme.colors.textSecondary} style={styles.settingIcon} />
                            <View>
                                <Text style={[styles.settingLabel, { color: theme.colors.text }]}>{t('settings.supportFeedback.helpSupport')}</Text>
                                <Text style={[styles.settingDescription, { color: theme.colors.textSecondary }]}>
                                    {t('settings.supportFeedback.helpSupportDesc')}
                                </Text>
                            </View>
                        </View>
                        <IconComponent name="chevron-forward" size={16} color={theme.colors.textTertiary} />
                    </TouchableOpacity>

                    <TouchableOpacity
                        style={[styles.settingItem, { backgroundColor: theme.colors.card }]}
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
                            <IconComponent name="chatbubble" size={20} color={theme.colors.textSecondary} style={styles.settingIcon} />
                            <View>
                                <Text style={[styles.settingLabel, { color: theme.colors.text }]}>
                                    {t('settings.supportFeedback.sendFeedback')}
                                </Text>
                                <Text style={[styles.settingDescription, { color: theme.colors.textSecondary }]}>
                                    {t('settings.supportFeedback.sendFeedbackDesc')}
                                </Text>
                            </View>
                        </View>
                        <IconComponent name="chevron-forward" size={16} color={theme.colors.textTertiary} />
                    </TouchableOpacity>

                    <TouchableOpacity
                        style={[styles.settingItem, styles.lastSettingItem, { backgroundColor: theme.colors.card }]}
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
                            <IconComponent name="star" size={20} color={theme.colors.textSecondary} style={styles.settingIcon} />
                            <View>
                                <Text style={[styles.settingLabel, { color: theme.colors.text }]}>{t('settings.supportFeedback.rateApp')}</Text>
                                <Text style={[styles.settingDescription, { color: theme.colors.textSecondary }]}>
                                    {t('settings.supportFeedback.rateAppDesc')}
                                </Text>
                            </View>
                        </View>
                        <IconComponent name="chevron-forward" size={16} color={theme.colors.textTertiary} />
                    </TouchableOpacity>
                </View>

                {/* App Preferences */}
                <View style={styles.section}>
                    <Text style={[styles.sectionTitle, { color: theme.colors.text }]}>{t('settings.sections.preferences')}</Text>

                    {/* Language Selection */}
                    <TouchableOpacity
                        style={[styles.settingItem, styles.firstSettingItem, { backgroundColor: theme.colors.card }]}
                        onPress={() => router.push('/settings/language')}
                    >
                        <View style={styles.settingInfo}>
                            <IconComponent name="language" size={20} color={theme.colors.textSecondary} style={styles.settingIcon} />
                            <View>
                                <Text style={[styles.settingLabel, { color: theme.colors.text }]}>{t('Language')}</Text>
                                <Text style={[styles.settingDescription, { color: theme.colors.textSecondary }]}>{t('Select your preferred language')}</Text>
                            </View>
                        </View>
                        <IconComponent name="chevron-forward" size={16} color={theme.colors.textTertiary} />
                    </TouchableOpacity>

                    <View style={[styles.settingItem, { backgroundColor: theme.colors.card }]}>
                        <View style={styles.settingInfo}>
                            <IconComponent
                                name="notifications"
                                size={20}
                                color={theme.colors.textSecondary}
                                style={styles.settingIcon}
                            />
                            <View>
                                <Text style={[styles.settingLabel, { color: theme.colors.text }]}>{t('settings.preferences.notifications')}</Text>
                                <Text style={[styles.settingDescription, { color: theme.colors.textSecondary }]}>
                                    {t('settings.preferences.notificationsDesc')}
                                </Text>
                            </View>
                        </View>
                        <Switch
                            value={notifications}
                            onValueChange={onToggleNotifications}
                            trackColor={{ false: theme.colors.border, true: theme.colors.primary }}
                            thumbColor={theme.colors.card}
                            ios_backgroundColor={theme.colors.backgroundTertiary}
                        />
                    </View>

                    <View style={[styles.settingItem, { backgroundColor: theme.colors.card }]}>
                        <View style={styles.settingInfo}>
                            <IconComponent name="moon" size={20} color={theme.colors.textSecondary} style={styles.settingIcon} />
                            <View>
                                <Text style={[styles.settingLabel, { color: theme.colors.text }]}>{t('settings.preferences.darkMode')}</Text>
                                <Text style={[styles.settingDescription, { color: theme.colors.textSecondary }]}>
                                    {t('settings.preferences.darkModeDesc')}
                                </Text>
                            </View>
                        </View>
                        <Switch
                            value={darkMode}
                            onValueChange={setDarkMode}
                            trackColor={{ false: theme.colors.border, true: theme.colors.primary }}
                            thumbColor={theme.colors.card}
                            ios_backgroundColor={theme.colors.backgroundTertiary}
                        />
                    </View>

                    <View style={[styles.settingItem, { backgroundColor: theme.colors.card }]}>
                        <View style={styles.settingInfo}>
                            <IconComponent name="sync" size={20} color={theme.colors.textSecondary} style={styles.settingIcon} />
                            <View>
                                <Text style={[styles.settingLabel, { color: theme.colors.text }]}>{t('settings.preferences.autoSync')}</Text>
                                <Text style={[styles.settingDescription, { color: theme.colors.textSecondary }]}>
                                    {t('settings.preferences.autoSyncDesc')}
                                </Text>
                            </View>
                        </View>
                        <Switch
                            value={autoSync}
                            onValueChange={setAutoSync}
                            trackColor={{ false: theme.colors.border, true: theme.colors.primary }}
                            thumbColor={theme.colors.card}
                            ios_backgroundColor={theme.colors.backgroundTertiary}
                        />
                    </View>

                    <View style={[styles.settingItem, styles.lastSettingItem, { backgroundColor: theme.colors.card }]}>
                        <View style={styles.settingInfo}>
                            <IconComponent
                                name="cloud-offline"
                                size={20}
                                color={theme.colors.textSecondary}
                                style={styles.settingIcon}
                            />
                            <View>
                                <Text style={[styles.settingLabel, { color: theme.colors.text }]}>{t('settings.preferences.offlineMode')}</Text>
                                <Text style={[styles.settingDescription, { color: theme.colors.textSecondary }]}>
                                    {t('settings.preferences.offlineModeDesc')}
                                </Text>
                            </View>
                        </View>
                        <Switch
                            value={offlineMode}
                            onValueChange={setOfflineMode}
                            trackColor={{ false: theme.colors.border, true: theme.colors.primary }}
                            thumbColor={theme.colors.card}
                            ios_backgroundColor={theme.colors.backgroundTertiary}
                        />
                    </View>
                </View>

                {/* Quick Actions */}
                <View style={styles.section}>
                    <Text style={[styles.sectionTitle, { color: theme.colors.text }]}>{t('settings.sections.quickActions')}</Text>

                    <TouchableOpacity
                        style={[styles.settingItem, styles.firstSettingItem, { backgroundColor: theme.colors.card }]}
                        onPress={() => router.push('/properties/create')}
                    >
                        <View style={styles.settingInfo}>
                            <IconComponent name="add" size={20} color={theme.colors.textSecondary} style={styles.settingIcon} />
                            <View>
                                <Text style={[styles.settingLabel, { color: theme.colors.text }]}>{t('settings.quickActions.createProperty')}</Text>
                                <Text style={[styles.settingDescription, { color: theme.colors.textSecondary }]}>
                                    {t('settings.quickActions.createPropertyDesc')}
                                </Text>
                            </View>
                        </View>
                        <IconComponent name="chevron-forward" size={16} color={theme.colors.textTertiary} />
                    </TouchableOpacity>

                    <TouchableOpacity
                        style={[styles.settingItem, styles.lastSettingItem, { backgroundColor: theme.colors.card }]}
                        onPress={() => router.push('/search')}
                    >
                        <View style={styles.settingInfo}>
                            <IconComponent name="search" size={20} color={theme.colors.textSecondary} style={styles.settingIcon} />
                            <View>
                                <Text style={[styles.settingLabel, { color: theme.colors.text }]}>
                                    {t('settings.quickActions.searchProperties')}
                                </Text>
                                <Text style={[styles.settingDescription, { color: theme.colors.textSecondary }]}>
                                    {t('settings.quickActions.searchPropertiesDesc')}
                                </Text>
                            </View>
                        </View>
                        <IconComponent name="chevron-forward" size={16} color={theme.colors.textTertiary} />
                    </TouchableOpacity>
                </View>

                {/* Data Management */}
                <View style={styles.section}>
                    <Text style={[styles.sectionTitle, { color: theme.colors.text }]}>{t('settings.sections.data')}</Text>

                    <TouchableOpacity
                        style={[styles.settingItem, styles.firstSettingItem, { backgroundColor: theme.colors.card }]}
                        onPress={handleExportData}
                    >
                        <View style={styles.settingInfo}>
                            <IconComponent name="download" size={20} color={theme.colors.textSecondary} style={styles.settingIcon} />
                            <View>
                                <Text style={[styles.settingLabel, { color: theme.colors.text }]}>{t('settings.data.exportData')}</Text>
                                <Text style={[styles.settingDescription, { color: theme.colors.textSecondary }]}>{t('settings.data.exportDataDesc')}</Text>
                            </View>
                        </View>
                        <IconComponent name="chevron-forward" size={16} color={theme.colors.textTertiary} />
                    </TouchableOpacity>

                    <TouchableOpacity
                        style={[styles.settingItem, styles.lastSettingItem, { backgroundColor: theme.colors.card }]}
                        onPress={handleClearCache}
                    >
                        <View style={styles.settingInfo}>
                            <IconComponent name="trash" size={20} color={theme.colors.error} style={styles.settingIcon} />
                            <View>
                                <Text style={[styles.settingLabel, { color: theme.colors.error }]}>
                                    {t("settings.data.clearCache")}
                                </Text>
                                <Text style={[styles.settingDescription, { color: theme.colors.textSecondary }]}>{t("settings.data.clearCacheDesc")}</Text>
                            </View>
                        </View>
                        <IconComponent name="chevron-forward" size={16} color={theme.colors.textTertiary} />
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
                            { backgroundColor: theme.colors.card, borderColor: theme.colors.error },
                        ]}
                        onPress={handleSignOut}
                    >
                        <View style={styles.settingInfo}>
                            <IconComponent name="log-out" size={20} color={theme.colors.error} style={styles.settingIcon} />
                            <View>
                                <Text style={[styles.settingLabel, { color: theme.colors.error }]}>
                                    {t("settings.signOut")}
                                </Text>
                                <Text style={[styles.settingDescription, { color: theme.colors.textSecondary }]}>{t("settings.signOutDesc")}</Text>
                            </View>
                        </View>
                    </TouchableOpacity>
                </View>
            </Animated.ScrollView>
        </ThemedView>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
    },
    scrollView: {
        flex: 1,
    },
    content: {
        paddingHorizontal: 20,
        paddingTop: 16,
        paddingBottom: 16,
    },
    userIcon: {
        width: 40,
        height: 40,
        borderRadius: 20,
        // backgroundColor will be applied inline with theme
        alignItems: "center",
        justifyContent: "center",
        marginRight: 12,
    },
    section: {
        marginBottom: 32,
    },
    sectionTitle: {
        fontSize: 16,
        fontWeight: "600",
        // color will be applied inline with theme
        marginBottom: 12,
        paddingHorizontal: 0,
    },
    settingItem: {
        // backgroundColor will be applied inline with theme
        paddingHorizontal: 16,
        paddingVertical: 14,
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
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
        flexDirection: "row",
        alignItems: "center",
        flex: 1,
    },
    settingIcon: {
        marginRight: 12,
        width: 20,
        height: 20,
        alignItems: "center",
        justifyContent: "center",
    },
    settingLabel: {
        fontSize: 16,
        fontWeight: "500",
        // color will be applied inline with theme
        marginBottom: 2,
    },
    settingDescription: {
        fontSize: 14,
        // color will be applied inline with theme
    },
    signOutButton: {
        borderWidth: 1,
        // borderColor will be applied inline with theme (error color)
    },
});
