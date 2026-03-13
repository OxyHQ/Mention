import { useCallback, useEffect, useState, useRef, useMemo } from "react";
import { View, Text, TouchableOpacity, Alert, Platform, Animated } from "react-native";
import { ThemedView } from "@/components/ThemedView";
import { Header } from "@/components/Header";
import { IconButton } from '@/components/ui/Button';
import { Toggle } from "@/components/Toggle";
import { BackArrowIcon } from "@/assets/icons/back-arrow-icon";
import { useAuth } from "@oxyhq/services";
import { useTranslation } from "react-i18next";
import { useLayoutScroll } from "@/context/LayoutScrollContext";

import { Ionicons } from "@expo/vector-icons";
import Constants from "expo-constants";
import { useRouter } from "expo-router";
import { LogoIcon } from "@/assets/logo";
import { authenticatedClient } from "@/utils/api";
import { confirmDialog, alertDialog } from "@/utils/alerts";
import { getData, storeData } from "@/utils/storage";
// (already imported above)
import { hasNotificationPermission, requestNotificationPermissions, getDevicePushToken } from "@/utils/notifications";
import { useTheme } from "@/hooks/useTheme";
import { useAppearanceStore } from "@/store/appearanceStore";
import { useHapticsStore } from "@/stores/hapticsStore";
import { useColorScheme } from "@/lib/useColorScheme";
import { useProfileData } from "@/hooks/useProfileData";
import i18n from 'i18next';
import { ScrollView } from "react-native";

// Type assertion for Ionicons compatibility with React 19
const IconComponent = Ionicons as any;

export default function SettingsScreen() {
    const { t } = useTranslation();
    const router = useRouter();
    const { user, showBottomSheet } = useAuth();
    const { colors } = useTheme();
    // Use useProfileData to get customized display name for current user
    const { data: currentUserProfile } = useProfileData(user?.username);
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
    // Get theme mode from appearance store
    const mySettings = useAppearanceStore((state) => state.mySettings);
    const updateMySettings = useAppearanceStore((state) => state.updateMySettings);
    const loadMySettings = useAppearanceStore((state) => state.loadMySettings);
    const { colorScheme: currentColorScheme } = useColorScheme();

    // Load settings on mount if not already loaded
    useEffect(() => {
        if (!mySettings) {
            loadMySettings();
        }
    }, [mySettings, loadMySettings]);

    // Determine if dark mode is currently active (useColorScheme already handles system preference)
    const isDarkModeActive = currentColorScheme === 'dark';

    const handleDarkModeToggle = useCallback(async (value: boolean) => {
        const newThemeMode = value ? 'dark' : 'light';
        await updateMySettings({
            appearance: {
                themeMode: newThemeMode,
                primaryColor: mySettings?.appearance?.primaryColor,
            },
        } as any);
    }, [updateMySettings, mySettings?.appearance?.primaryColor]);

    // Get current language
    const [currentLanguage, setCurrentLanguage] = useState<string>('en-US');
    useEffect(() => {
        const loadLanguage = async () => {
            try {
                const LANGUAGE_STORAGE_KEY = 'user_language_preference';
                const savedLanguage = await getData<string>(LANGUAGE_STORAGE_KEY);
                const language = savedLanguage || i18n.language || 'en-US';
                setCurrentLanguage(language);
            } catch (error) {
                setCurrentLanguage(i18n.language || 'en-US');
            }
        };
        loadLanguage();

        // Listen for language changes
        const handleLanguageChanged = (lng: string) => {
            setCurrentLanguage(lng);
        };
        i18n.on('languageChanged', handleLanguageChanged);

        return () => {
            i18n.off('languageChanged', handleLanguageChanged);
        };
    }, []);

    const getLanguageDisplayName = useCallback((code: string) => {
        const languages: Record<string, string> = {
            'en-US': 'English',
            'es-ES': 'Espa\u00F1ol',
            'it-IT': 'Italiano',
        };
        return languages[code] || code;
    }, []);

    const handleSignOut = async () => {
        const confirmed = await confirmDialog({
            title: t('settings.signOut'),
            message: t('settings.signOutMessage'),
            okText: t('settings.signOut'),
            cancelText: t('common.cancel'),
            destructive: true,
        });
        if (!confirmed) return;
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
        await alertDialog({ title: t('common.success'), message: t('settings.data.clearCacheSuccess') });
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
                message: t('settings.data.resetPersonalizationSuccess')
            });
        } catch (error) {
            console.error('Error resetting personalization:', error);
            await alertDialog({
                title: t('common.error'),
                message: t('settings.data.resetPersonalizationError')
            });
        }
    };

    const handleExportData = async () => {
        const confirmed = await confirmDialog({
            title: t('settings.data.exportData', 'Export Your Data'),
            message: t('settings.data.exportDataMessage', 'This will collect all your posts, likes, bookmarks, and settings into a JSON export.'),
            okText: t('common.export', 'Export'),
            cancelText: t('common.cancel'),
        });
        if (!confirmed) return;

        try {
            await authenticatedClient.post('/profile/export');
            await alertDialog({
                title: t('common.success'),
                message: t('settings.data.exportDataSuccess', 'Your data export has been prepared successfully.'),
            });
        } catch (error) {
            console.error('Error exporting data:', error);
            await alertDialog({
                title: t('common.error'),
                message: t('settings.data.exportDataError', 'Failed to export data. Please try again later.'),
            });
        }
    };

    const handleDeactivateAccount = async () => {
        const confirmed = await confirmDialog({
            title: t('settings.account.deactivate', 'Deactivate Account'),
            message: t('settings.account.deactivateMessage', 'This will temporarily hide your account. You can reactivate it by signing in again.'),
            okText: t('settings.account.deactivateConfirm', 'Deactivate'),
            cancelText: t('common.cancel'),
            destructive: true,
        });
        if (!confirmed) return;
        await alertDialog({
            title: t('settings.account.contactSupport', 'Contact Support'),
            message: t('settings.account.contactSupportMessage', 'To deactivate your account, please contact support at support@mention.earth'),
        });
    };

    const handleDeleteAccount = async () => {
        const confirmed = await confirmDialog({
            title: t('settings.account.delete', 'Delete Account'),
            message: t('settings.account.deleteMessage', 'This action is permanent and cannot be undone. All your data will be deleted.'),
            okText: t('settings.account.deleteConfirm', 'Delete Account'),
            cancelText: t('common.cancel'),
            destructive: true,
        });
        if (!confirmed) return;
        await alertDialog({
            title: t('settings.account.contactSupport', 'Contact Support'),
            message: t('settings.account.contactSupportMessage', 'To delete your account, please contact support at support@mention.earth'),
        });
    };

    return (
        <ThemedView className="flex-1">
            {/* Header */}
            <Header
                options={{
                    title: t("settings.title"),
                    leftComponents: [
                        <IconButton variant="icon"
                            key="back"
                            onPress={() => router.back()}
                        >
                            <BackArrowIcon size={20} className="text-foreground" />
                        </IconButton>,
                    ],
                }}
                hideBottomBorder={true}
                disableSticky={true}
            />

            <Animated.ScrollView
                ref={assignScrollViewRef}
                className="flex-1"
                contentContainerClassName="px-4 pt-5 pb-6"
                showsVerticalScrollIndicator={false}
                onScroll={onScroll}
                scrollEventThrottle={scrollEventThrottle}
                {...(Platform.OS === 'web' ? { dataSet: { layoutscroll: 'true' } } : {}) as any}
            >
                {/* User Info */}
                <View className="mb-8">
                    <Text className="text-[13px] font-semibold uppercase tracking-wide mb-3 px-1 text-foreground">{t("settings.sections.account")}</Text>

                    <View className="rounded-2xl border border-border bg-card overflow-hidden">
                        <TouchableOpacity
                            className="px-4 py-4 pt-[18px] flex-row items-center justify-between"
                            onPress={() => showBottomSheet?.("AccountSettings")}
                        >
                            <View className="w-10 h-10 rounded-full items-center justify-center mr-3" style={{ backgroundColor: colors.primary }}>
                                <IconComponent name="person" size={24} color={colors.card} />
                            </View>
                            <View className="flex-row items-center flex-1">
                                <View>
                                    <Text className="text-base font-medium mb-0.5 text-foreground">
                                        {currentUserProfile?.design?.displayName ||
                                            (user
                                                ? typeof user.name === 'string'
                                                    ? user.name
                                                    : user.name?.full || user.name?.first || user.username
                                                : 'User')}
                                    </Text>
                                    <Text className="text-sm text-muted-foreground">{user?.username || 'Username'}</Text>
                                </View>
                            </View>
                            <IconComponent name="chevron-forward" size={16} color={colors.textTertiary} />
                        </TouchableOpacity>
                        <View className="h-px mx-4 bg-border" />
                        <TouchableOpacity
                            className="px-4 py-4 pb-[18px] flex-row items-center justify-between"
                            onPress={() => showBottomSheet?.("FileManagement")}
                        >
                            <View className="w-10 h-10 rounded-full items-center justify-center mr-3" style={{ backgroundColor: colors.primary }}>
                                <IconComponent name="person" size={24} color={colors.card} />
                            </View>
                            <View className="flex-row items-center flex-1">
                                <View>
                                    <Text className="text-base font-medium mb-0.5 text-foreground">
                                        {user
                                            ? typeof user.name === 'string'
                                                ? user.name
                                                : user.name?.full || user.name?.first || user.username
                                            : 'User'}
                                    </Text>
                                    <Text className="text-sm text-muted-foreground">{user?.username || 'Username'}</Text>
                                </View>
                            </View>
                            <IconComponent name="chevron-forward" size={16} color={colors.textTertiary} />
                        </TouchableOpacity>
                    </View>
                </View>

                {/* About Mention */}
                <View className="mb-8">
                    <Text className="text-[13px] font-semibold uppercase tracking-wide mb-3 px-1 text-foreground">{t('settings.sections.aboutMention')}</Text>

                    <View className="rounded-2xl border border-border bg-card overflow-hidden">
                        {/* App Title and Version */}
                        <View className="px-4 py-4 pt-[18px] flex-row items-center justify-between">
                            <View className="flex-row items-center flex-1">
                                <View className="mr-3 items-center justify-center">
                                    <LogoIcon size={20} className="text-primary" />
                                </View>
                                <View>
                                    <Text className="text-base font-medium mb-0.5 text-foreground">{t('settings.aboutMention.appName')}</Text>
                                    <Text className="text-sm text-muted-foreground">
                                        {t('settings.aboutMention.version', {
                                            version: Constants.expoConfig?.version || '1.0.0',
                                        })}
                                    </Text>
                                </View>
                            </View>
                        </View>

                        <View className="h-px mx-4 bg-border" />

                        {/* Build Info */}
                        <View className="px-4 py-4 flex-row items-center justify-between">
                            <View className="flex-row items-center flex-1">
                                <View className="mr-3 items-center justify-center">
                                    <IconComponent name="hammer" size={20} color={colors.textSecondary} />
                                </View>
                                <View>
                                    <Text className="text-base font-medium mb-0.5 text-foreground">{t('settings.aboutMention.build')}</Text>
                                    <Text className="text-sm text-muted-foreground">
                                        {typeof Constants.expoConfig?.runtimeVersion === 'string'
                                            ? Constants.expoConfig.runtimeVersion
                                            : t('settings.aboutMention.buildVersion')}
                                    </Text>
                                </View>
                            </View>
                        </View>

                        <View className="h-px mx-4 bg-border" />

                        {/* Platform Info */}
                        <View className="px-4 py-4 flex-row items-center justify-between">
                            <View className="flex-row items-center flex-1">
                                <View className="mr-3 items-center justify-center">
                                    <IconComponent
                                        name="phone-portrait"
                                        size={20}
                                        color={colors.textSecondary}
                                    />
                                </View>
                                <View>
                                    <Text className="text-base font-medium mb-0.5 text-foreground">{t('settings.aboutMention.platform')}</Text>
                                    <Text className="text-sm text-muted-foreground">
                                        {Constants.platform?.ios
                                            ? 'iOS'
                                            : Constants.platform?.android
                                                ? 'Android'
                                                : 'Web'}
                                    </Text>
                                </View>
                            </View>
                        </View>

                        <View className="h-px mx-4 bg-border" />

                        {/* Oxy SDK */}
                        <TouchableOpacity className="px-4 py-4 flex-row items-center justify-between" onPress={() => showBottomSheet?.('AppInfo')}>
                            <View className="flex-row items-center flex-1">
                                <View className="mr-3 items-center justify-center">
                                    <IconComponent name="code-slash" size={20} color={colors.textSecondary} />
                                </View>
                                <View>
                                    <Text className="text-base font-medium mb-0.5 text-foreground">{t('settings.aboutMention.oxySDK')}</Text>
                                    <Text className="text-sm text-muted-foreground">{oxySdkVersion}</Text>
                                </View>
                            </View>
                        </TouchableOpacity>

                        <View className="h-px mx-4 bg-border" />

                        {/* Expo SDK */}
                        <View className="px-4 py-4 flex-row items-center justify-between">
                            <View className="flex-row items-center flex-1">
                                <View className="mr-3 items-center justify-center">
                                    <IconComponent name="code-slash" size={20} color={colors.textSecondary} />
                                </View>
                                <View>
                                    <Text className="text-base font-medium mb-0.5 text-foreground">{t('settings.aboutMention.expoSDK')}</Text>
                                    <Text className="text-sm text-muted-foreground">{expoSdkVersion}</Text>
                                </View>
                            </View>
                        </View>

                        <View className="h-px mx-4 bg-border" />

                        {/* API URL (from env/config) */}
                        <View className="px-4 py-4 pb-[18px] flex-row items-center justify-between">
                            <View className="flex-row items-center flex-1">
                                <View className="mr-3 items-center justify-center">
                                    <IconComponent name="globe" size={20} color={colors.textSecondary} />
                                </View>
                                <View>
                                    <Text className="text-base font-medium mb-0.5 text-foreground">{t('settings.aboutMention.apiUrl')}</Text>
                                    <Text className="text-sm text-muted-foreground">{apiUrl}</Text>
                                </View>
                            </View>
                        </View>
                    </View>
                </View>

                {/* Support & Feedback */}
                <View className="mb-8">
                    <Text className="text-[13px] font-semibold uppercase tracking-wide mb-3 px-1 text-foreground">{t('settings.sections.supportFeedback')}</Text>

                    <View className="rounded-2xl border border-border bg-card overflow-hidden">
                        <TouchableOpacity
                            className="px-4 py-4 pt-[18px] flex-row items-center justify-between"
                            onPress={() => {
                                Alert.alert(
                                    t('settings.supportFeedback.helpSupport'),
                                    t('settings.supportFeedback.helpSupportMessage'),
                                    [{ text: t('common.ok') }],
                                );
                            }}
                        >
                            <View className="flex-row items-center flex-1">
                                <View className="mr-3 items-center justify-center">
                                    <IconComponent name="help-circle" size={20} color={colors.textSecondary} />
                                </View>
                                <View>
                                    <Text className="text-base font-medium mb-0.5 text-foreground">{t('settings.supportFeedback.helpSupport')}</Text>
                                    <Text className="text-sm text-muted-foreground">
                                        {t('settings.supportFeedback.helpSupportDesc')}
                                    </Text>
                                </View>
                            </View>
                            <IconComponent name="chevron-forward" size={16} color={colors.textTertiary} />
                        </TouchableOpacity>

                        <View className="h-px mx-4 bg-border" />

                        <TouchableOpacity
                            className="px-4 py-4 flex-row items-center justify-between"
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
                            <View className="flex-row items-center flex-1">
                                <View className="mr-3 items-center justify-center">
                                    <IconComponent name="chatbubble" size={20} color={colors.textSecondary} />
                                </View>
                                <View>
                                    <Text className="text-base font-medium mb-0.5 text-foreground">
                                        {t('settings.supportFeedback.sendFeedback')}
                                    </Text>
                                    <Text className="text-sm text-muted-foreground">
                                        {t('settings.supportFeedback.sendFeedbackDesc')}
                                    </Text>
                                </View>
                            </View>
                            <IconComponent name="chevron-forward" size={16} color={colors.textTertiary} />
                        </TouchableOpacity>

                        <View className="h-px mx-4 bg-border" />

                        <TouchableOpacity
                            className="px-4 py-4 pb-[18px] flex-row items-center justify-between"
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
                            <View className="flex-row items-center flex-1">
                                <View className="mr-3 items-center justify-center">
                                    <IconComponent name="star" size={20} color={colors.textSecondary} />
                                </View>
                                <View>
                                    <Text className="text-base font-medium mb-0.5 text-foreground">{t('settings.supportFeedback.rateApp')}</Text>
                                    <Text className="text-sm text-muted-foreground">
                                        {t('settings.supportFeedback.rateAppDesc')}
                                    </Text>
                                </View>
                            </View>
                            <IconComponent name="chevron-forward" size={16} color={colors.textTertiary} />
                        </TouchableOpacity>
                    </View>
                </View>

                {/* Privacy */}
                <View className="mb-8">
                    <Text className="text-[13px] font-semibold uppercase tracking-wide mb-3 px-1 text-foreground">{t('settings.sections.privacy')}</Text>

                    <View className="rounded-2xl border border-border bg-card overflow-hidden">
                        <TouchableOpacity
                            className="px-4 pt-[18px] pb-[18px] flex-row items-center justify-between"
                            onPress={() => router.push('/settings/privacy')}
                        >
                            <View className="flex-row items-center flex-1">
                                <View className="mr-3 items-center justify-center">
                                    <IconComponent name="lock-closed" size={20} color={colors.textSecondary} />
                                </View>
                                <View>
                                    <Text className="text-base font-medium mb-0.5 text-foreground">
                                        {t('settings.privacy.title')}
                                    </Text>
                                    <Text className="text-sm text-muted-foreground">
                                        {t('settings.privacy.description')}
                                    </Text>
                                </View>
                            </View>
                            <IconComponent name="chevron-forward" size={16} color={colors.textTertiary} />
                        </TouchableOpacity>
                    </View>
                </View>

                {/* App Preferences */}
                <View className="mb-8">
                    <Text className="text-[13px] font-semibold uppercase tracking-wide mb-3 px-1 text-foreground">{t('settings.sections.preferences')}</Text>

                    <View className="rounded-2xl border border-border bg-card overflow-hidden">
                        {/* Appearance */}
                        <TouchableOpacity
                            className="px-4 py-4 pt-[18px] flex-row items-center justify-between"
                            onPress={() => router.push('/settings/appearance')}
                        >
                            <View className="flex-row items-center flex-1">
                                <View className="mr-3 items-center justify-center">
                                    <IconComponent name="color-palette" size={20} color={colors.textSecondary} />
                                </View>
                                <View>
                                    <Text className="text-base font-medium mb-0.5 text-foreground">{t('settings.preferences.appearance')}</Text>
                                    <Text className="text-sm text-muted-foreground">
                                        {t('settings.preferences.appearanceDesc')}
                                    </Text>
                                </View>
                            </View>
                            <IconComponent name="chevron-forward" size={16} color={colors.textTertiary} />
                        </TouchableOpacity>

                        <View className="h-px mx-4 bg-border" />

                        {/* Language Selection */}
                        <TouchableOpacity
                            className="px-4 py-4 flex-row items-center justify-between"
                            onPress={() => router.push('/settings/language')}
                        >
                            <View className="flex-row items-center flex-1">
                                <View className="mr-3 items-center justify-center">
                                    <IconComponent name="language" size={20} color={colors.textSecondary} />
                                </View>
                                <View>
                                    <Text className="text-base font-medium mb-0.5 text-foreground">{t('Language')}</Text>
                                    <Text className="text-sm text-muted-foreground">
                                        {getLanguageDisplayName(currentLanguage)}
                                    </Text>
                                </View>
                            </View>
                            <IconComponent name="chevron-forward" size={16} color={colors.textTertiary} />
                        </TouchableOpacity>

                        <View className="h-px mx-4 bg-border" />

                        {/* Profile Customization */}
                        <TouchableOpacity
                            className="px-4 py-4 flex-row items-center justify-between"
                            onPress={() => router.push('/settings/profile-customization')}
                        >
                            <View className="flex-row items-center flex-1">
                                <View className="mr-3 items-center justify-center">
                                    <IconComponent name="person-circle-outline" size={20} color={colors.textSecondary} />
                                </View>
                                <View>
                                    <Text className="text-base font-medium mb-0.5 text-foreground">
                                        {t('settings.preferences.profileCustomization')}
                                    </Text>
                                    <Text className="text-sm text-muted-foreground">
                                        {t('settings.preferences.profileCustomizationDesc')}
                                    </Text>
                                </View>
                            </View>
                            <IconComponent name="chevron-forward" size={16} color={colors.textTertiary} />
                        </TouchableOpacity>

                        <View className="h-px mx-4 bg-border" />

                        {/* Your Interests */}
                        <TouchableOpacity
                            className="px-4 py-4 flex-row items-center justify-between"
                            onPress={() => router.push('/settings/interests')}
                        >
                            <View className="flex-row items-center flex-1">
                                <View className="mr-3 items-center justify-center">
                                    <IconComponent name="heart-outline" size={20} color={colors.textSecondary} />
                                </View>
                                <View>
                                    <Text className="text-base font-medium mb-0.5 text-foreground">
                                        {t('settings.preferences.interests', { defaultValue: 'Your interests' })}
                                    </Text>
                                    <Text className="text-sm text-muted-foreground">
                                        {t('settings.preferences.interestsDesc', { defaultValue: 'Select your interests to personalize your feed' })}
                                    </Text>
                                </View>
                            </View>
                            <IconComponent name="chevron-forward" size={16} color={colors.textTertiary} />
                        </TouchableOpacity>

                        <View className="h-px mx-4 bg-border" />

                        {/* Feed Settings */}
                        <TouchableOpacity
                            className="px-4 py-4 flex-row items-center justify-between"
                            onPress={() => router.push('/settings/feed')}
                        >
                            <View className="flex-row items-center flex-1">
                                <View className="mr-3 items-center justify-center">
                                    <IconComponent name="newspaper-outline" size={20} color={colors.textSecondary} />
                                </View>
                                <View>
                                    <Text className="text-base font-medium mb-0.5 text-foreground">
                                        {t('settings.feed.title')}
                                    </Text>
                                    <Text className="text-sm text-muted-foreground">
                                        {t('settings.feed.description')}
                                    </Text>
                                </View>
                            </View>
                            <IconComponent name="chevron-forward" size={16} color={colors.textTertiary} />
                        </TouchableOpacity>

                        <View className="h-px mx-4 bg-border" />

                        <TouchableOpacity
                            className="px-4 py-4 flex-row items-center justify-between"
                            onPress={() => router.push('/settings/notifications')}
                        >
                            <View className="flex-row items-center flex-1">
                                <View className="mr-3 items-center justify-center">
                                    <IconComponent
                                        name="notifications"
                                        size={20}
                                        color={colors.textSecondary}
                                    />
                                </View>
                                <View>
                                    <Text className="text-base font-medium mb-0.5 text-foreground">{t('settings.preferences.notifications')}</Text>
                                    <Text className="text-sm text-muted-foreground">
                                        {t('settings.preferences.notificationsDesc')}
                                    </Text>
                                </View>
                            </View>
                            <IconComponent name="chevron-forward" size={16} color={colors.textTertiary} />
                        </TouchableOpacity>

                        <View className="h-px mx-4 bg-border" />

                        <View className="px-4 py-4 pb-[18px] flex-row items-center justify-between">
                            <View className="flex-row items-center flex-1">
                                <View className="mr-3 items-center justify-center">
                                    <IconComponent name="moon" size={20} color={colors.textSecondary} />
                                </View>
                                <View>
                                    <Text className="text-base font-medium mb-0.5 text-foreground">{t('settings.preferences.darkMode')}</Text>
                                    <Text className="text-sm text-muted-foreground">
                                        {t('settings.preferences.darkModeDesc')}
                                    </Text>
                                </View>
                            </View>
                            <Toggle
                                value={isDarkModeActive}
                                onValueChange={handleDarkModeToggle}
                            />
                        </View>

                        {/* Haptic Feedback */}
                        {Platform.OS !== 'web' && (
                            <View className="px-4 py-4 flex-row items-center justify-between border-t border-border">
                                <View className="flex-row items-center flex-1">
                                    <View className="mr-3 items-center justify-center">
                                        <IconComponent name="hand-left" size={20} color={colors.textSecondary} />
                                    </View>
                                    <View>
                                        <Text className="text-base font-medium mb-0.5 text-foreground">Haptic Feedback</Text>
                                        <Text className="text-sm text-muted-foreground">
                                            Vibration feedback on interactions
                                        </Text>
                                    </View>
                                </View>
                                <Toggle
                                    value={!useHapticsStore.getState().disabled}
                                    onValueChange={(enabled) => useHapticsStore.getState().setDisabled(!enabled)}
                                />
                            </View>
                        )}
                    </View>
                </View>

                {/* Data Management */}
                <View className="mb-8">
                    <Text className="text-[13px] font-semibold uppercase tracking-wide mb-3 px-1 text-foreground">{t('settings.sections.data')}</Text>

                    <View className="rounded-2xl border border-border bg-card overflow-hidden">
                        <TouchableOpacity
                            className="px-4 py-4 pt-[18px] flex-row items-center justify-between"
                            onPress={handleExportData}
                        >
                            <View className="flex-row items-center flex-1">
                                <View className="mr-3 items-center justify-center">
                                    <IconComponent name="download" size={20} color={colors.textSecondary} />
                                </View>
                                <View>
                                    <Text className="text-base font-medium mb-0.5 text-foreground">{t('settings.data.exportData')}</Text>
                                    <Text className="text-sm text-muted-foreground">{t('settings.data.exportDataDesc')}</Text>
                                </View>
                            </View>
                            <IconComponent name="chevron-forward" size={16} color={colors.textTertiary} />
                        </TouchableOpacity>

                        <View className="h-px mx-4 bg-border" />

                        {/* Link Management */}
                        <TouchableOpacity
                            className="px-4 py-4 flex-row items-center justify-between"
                            onPress={() => router.push('/settings/links')}
                        >
                            <View className="flex-row items-center flex-1">
                                <View className="mr-3 items-center justify-center">
                                    <IconComponent name="link" size={20} color={colors.textSecondary} />
                                </View>
                                <View>
                                    <Text className="text-base font-medium mb-0.5 text-foreground">
                                        {t("settings.data.linkManagement")}
                                    </Text>
                                    <Text className="text-sm text-muted-foreground">
                                        {t("settings.data.linkManagementDesc")}
                                    </Text>
                                </View>
                            </View>
                            <IconComponent name="chevron-forward" size={16} color={colors.textTertiary} />
                        </TouchableOpacity>

                        <View className="h-px mx-4 bg-border" />

                        <TouchableOpacity
                            className="px-4 py-4 flex-row items-center justify-between"
                            onPress={handleClearCache}
                        >
                            <View className="flex-row items-center flex-1">
                                <View className="mr-3 items-center justify-center">
                                    <IconComponent name="trash" size={20} color={colors.error} />
                                </View>
                                <View>
                                    <Text className="text-base font-medium mb-0.5 text-destructive">
                                        {t("settings.data.clearCache")}
                                    </Text>
                                    <Text className="text-sm text-muted-foreground">{t("settings.data.clearCacheDesc")}</Text>
                                </View>
                            </View>
                            <IconComponent name="chevron-forward" size={16} color={colors.textTertiary} />
                        </TouchableOpacity>

                        <View className="h-px mx-4 bg-border" />

                        <TouchableOpacity
                            className="px-4 py-4 pb-[18px] flex-row items-center justify-between"
                            onPress={handleResetPersonalization}
                        >
                            <View className="flex-row items-center flex-1">
                                <View className="mr-3 items-center justify-center">
                                    <IconComponent name="refresh" size={20} color={colors.error} />
                                </View>
                                <View>
                                    <Text className="text-base font-medium mb-0.5 text-destructive">
                                        {t("settings.data.resetPersonalization")}
                                    </Text>
                                    <Text className="text-sm text-muted-foreground">
                                        {t("settings.data.resetPersonalizationDesc")}
                                    </Text>
                                </View>
                            </View>
                            <IconComponent name="chevron-forward" size={16} color={colors.textTertiary} />
                        </TouchableOpacity>
                    </View>
                </View>

                {/* Your Data */}
                <View className="mb-8">
                    <Text className="text-[13px] font-semibold uppercase tracking-wide mb-3 px-1 text-muted-foreground">
                        {t("settings.yourData", "Your Data")}
                    </Text>
                    <View className="rounded-2xl border border-border bg-card overflow-hidden">
                        <TouchableOpacity
                            className="px-4 pt-[18px] pb-[18px] flex-row items-center justify-between"
                            onPress={handleExportData}
                        >
                            <View className="flex-row items-center flex-1">
                                <View className="mr-3 items-center justify-center">
                                    <IconComponent name="download-outline" size={20} color={colors.textSecondary} />
                                </View>
                                <View>
                                    <Text className="text-base font-medium mb-0.5 text-foreground">
                                        {t("settings.data.requestExport", "Request Data Export")}
                                    </Text>
                                    <Text className="text-sm text-muted-foreground">
                                        {t("settings.data.requestExportDesc", "Download a copy of your posts, likes, and bookmarks")}
                                    </Text>
                                </View>
                            </View>
                            <IconComponent name="chevron-forward" size={16} color={colors.textTertiary} />
                        </TouchableOpacity>
                    </View>
                </View>

                {/* Account */}
                <View className="mb-8">
                    <Text className="text-[13px] font-semibold uppercase tracking-wide mb-3 px-1 text-muted-foreground">
                        {t("settings.account.title", "Account")}
                    </Text>
                    <View className="rounded-2xl border border-border bg-card overflow-hidden">
                        <TouchableOpacity
                            className="px-4 py-4 pt-[18px] flex-row items-center justify-between"
                            onPress={handleDeactivateAccount}
                        >
                            <View className="flex-row items-center flex-1">
                                <View className="mr-3 items-center justify-center">
                                    <IconComponent name="eye-off-outline" size={20} color={colors.textSecondary} />
                                </View>
                                <View>
                                    <Text className="text-base font-medium mb-0.5 text-foreground">
                                        {t("settings.account.deactivate", "Deactivate Account")}
                                    </Text>
                                    <Text className="text-sm text-muted-foreground">
                                        {t("settings.account.deactivateDesc", "Temporarily hide your account")}
                                    </Text>
                                </View>
                            </View>
                            <IconComponent name="chevron-forward" size={16} color={colors.textTertiary} />
                        </TouchableOpacity>

                        <View className="h-px mx-4 bg-border" />

                        <TouchableOpacity
                            className="px-4 py-4 pb-[18px] flex-row items-center justify-between"
                            onPress={handleDeleteAccount}
                        >
                            <View className="flex-row items-center flex-1">
                                <View className="mr-3 items-center justify-center">
                                    <IconComponent name="trash-outline" size={20} color={colors.error} />
                                </View>
                                <View>
                                    <Text className="text-base font-medium mb-0.5 text-destructive">
                                        {t("settings.account.delete", "Delete Account")}
                                    </Text>
                                    <Text className="text-sm text-muted-foreground">
                                        {t("settings.account.deleteDesc", "Permanently delete your account and all data")}
                                    </Text>
                                </View>
                            </View>
                            <IconComponent name="chevron-forward" size={16} color={colors.textTertiary} />
                        </TouchableOpacity>
                    </View>
                </View>

                {/* Sign Out */}
                <View className="mb-8">
                    <TouchableOpacity
                        className="px-4 pt-[18px] pb-[18px] flex-row items-center justify-between rounded-2xl border bg-card overflow-hidden"
                        style={{ borderColor: colors.error }}
                        onPress={handleSignOut}
                    >
                        <View className="flex-row items-center flex-1">
                            <View className="mr-3 items-center justify-center">
                                <IconComponent name="log-out" size={20} color={colors.error} />
                            </View>
                            <View>
                                <Text className="text-base font-medium mb-0.5 text-destructive">
                                    {t("settings.signOut")}
                                </Text>
                                <Text className="text-sm text-muted-foreground">{t("settings.signOutDesc")}</Text>
                            </View>
                        </View>
                    </TouchableOpacity>
                </View>
            </Animated.ScrollView>
        </ThemedView>
    );
}
