import { useCallback, useEffect, useState, useRef, useMemo } from "react";
import { View, Text, TouchableOpacity, Platform, Animated, ScrollView } from "react-native";
import { ThemedView } from "@/components/ThemedView";
import { Header } from "@/components/Header";
import { IconButton } from '@/components/ui/Button';
import { BackArrowIcon } from "@/assets/icons/back-arrow-icon";
import { useAuth } from "@oxyhq/services";
import { useTranslation } from "react-i18next";
import { useLayoutScroll } from "@/context/LayoutScrollContext";
import { useRouter } from "expo-router";
import { useTheme } from "@/hooks/useTheme";
import { useProfileData } from "@/hooks/useProfileData";
import { useColorScheme } from "@/lib/useColorScheme";
import { confirmDialog } from "@/utils/alerts";
import Avatar from "@/components/Avatar";
import { SettingsItem, SettingsGroup } from "@/components/settings/SettingsItem";

export default function SettingsScreen() {
    const { t } = useTranslation();
    const router = useRouter();
    const { user } = useAuth();
    const { colors } = useTheme();
    const { data: currentUserProfile } = useProfileData(user?.username);
    const scrollViewRef = useRef<ScrollView>(null);
    const unregisterScrollableRef = useRef<(() => void) | null>(null);
    const { handleScroll, scrollEventThrottle, registerScrollable, forwardWheelEvent, createAnimatedScrollHandler } = useLayoutScroll();
    const { colorScheme } = useColorScheme();

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

    useEffect(() => {
        return () => {
            clearScrollRegistration();
        };
    }, [clearScrollRegistration]);

    const onScroll = useMemo(
        () => createAnimatedScrollHandler(handleScroll),
        [createAnimatedScrollHandler, handleScroll]
    );

    const handleWheelEvent = useCallback((event: React.WheelEvent) => {
        if (forwardWheelEvent) {
            forwardWheelEvent(event);
        }
    }, [forwardWheelEvent]);

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

    const displayName = currentUserProfile?.design?.displayName ||
        (user
            ? typeof user.name === 'string'
                ? user.name
                : user.name?.full || user.name?.first || user.username
            : 'User');

    return (
        <ThemedView className="flex-1">
            <Header
                options={{
                    title: t("settings.title"),
                    leftComponents: [
                        <IconButton variant="icon" key="back" onPress={() => router.back()}>
                            <BackArrowIcon size={20} className="text-foreground" />
                        </IconButton>,
                    ],
                }}
                hideBottomBorder
                disableSticky
            />

            <Animated.ScrollView
                ref={assignScrollViewRef}
                className="flex-1"
                contentContainerClassName="px-4 pt-4 pb-8"
                showsVerticalScrollIndicator={false}
                onScroll={onScroll}
                scrollEventThrottle={scrollEventThrottle}
                {...(Platform.OS === 'web' ? { dataSet: { layoutscroll: 'true' } } : {}) as Record<string, unknown>}
            >
                {/* Profile Preview */}
                <TouchableOpacity
                    className="flex-row items-center gap-3 mb-6 px-1"
                    onPress={() => router.push(`/profile/${user?.username}`)}
                    activeOpacity={0.7}
                >
                    <Avatar
                        source={currentUserProfile?.avatar || user?.avatar}
                        size={52}
                    />
                    <View className="flex-1">
                        <Text className="text-lg font-bold text-foreground" numberOfLines={1}>
                            {displayName}
                        </Text>
                        <Text className="text-sm text-muted-foreground" numberOfLines={1}>
                            @{user?.username || 'username'}
                        </Text>
                    </View>
                </TouchableOpacity>

                {/* Account */}
                <SettingsGroup title={t('settings.sections.account')}>
                    <SettingsItem
                        icon="person"
                        title={t('settings.account.title', { defaultValue: 'Account' })}
                        subtitle={t('settings.account.subtitle', { defaultValue: 'Email, password, deactivation' })}
                        onPress={() => router.push('/settings/account')}
                    />
                    <SettingsItem
                        icon="lock-closed"
                        title={t('settings.privacy.title')}
                        subtitle={t('settings.privacy.description')}
                        onPress={() => router.push('/settings/privacy')}
                    />
                </SettingsGroup>

                {/* Preferences */}
                <SettingsGroup title={t('settings.sections.preferences')}>
                    <SettingsItem
                        icon="notifications"
                        title={t('settings.preferences.notifications')}
                        subtitle={t('settings.preferences.notificationsDesc')}
                        onPress={() => router.push('/settings/notifications')}
                    />
                    <SettingsItem
                        icon="color-palette"
                        title={t('settings.preferences.appearance')}
                        subtitle={t('settings.preferences.appearanceDesc')}
                        onPress={() => router.push('/settings/appearance')}
                    />
                    <SettingsItem
                        icon="accessibility"
                        title={t('settings.accessibility.title', { defaultValue: 'Accessibility' })}
                        subtitle={t('settings.accessibility.subtitle', { defaultValue: 'Haptics, alt text, display' })}
                        onPress={() => router.push('/settings/accessibility')}
                    />
                    <SettingsItem
                        icon="language"
                        title={t('Language')}
                        subtitle={t('settings.preferences.languageDesc', { defaultValue: 'App and content languages' })}
                        onPress={() => router.push('/settings/language')}
                    />
                    <SettingsItem
                        icon="newspaper-outline"
                        title={t('settings.feed.title')}
                        subtitle={t('settings.feed.description')}
                        onPress={() => router.push('/settings/feed')}
                    />
                    <SettingsItem
                        icon="chatbubbles-outline"
                        title={t('settings.threadPreferences.title', { defaultValue: 'Thread preferences' })}
                        subtitle={t('settings.threadPreferences.subtitle', { defaultValue: 'Sort and display options for threads' })}
                        onPress={() => router.push('/settings/thread-preferences')}
                    />
                </SettingsGroup>

                {/* Profile */}
                <SettingsGroup title={t('settings.sections.profile', { defaultValue: 'Profile' })}>
                    <SettingsItem
                        icon="person-circle-outline"
                        title={t('settings.preferences.profileCustomization')}
                        subtitle={t('settings.preferences.profileCustomizationDesc')}
                        onPress={() => router.push('/settings/profile-customization')}
                    />
                    <SettingsItem
                        icon="heart-outline"
                        title={t('settings.preferences.interests', { defaultValue: 'Your interests' })}
                        subtitle={t('settings.preferences.interestsDesc', { defaultValue: 'Personalize your feed' })}
                        onPress={() => router.push('/settings/interests')}
                    />
                </SettingsGroup>

                {/* Support */}
                <SettingsGroup title={t('settings.sections.support', { defaultValue: 'Support' })}>
                    <SettingsItem
                        icon="help-circle"
                        title={t('settings.supportFeedback.helpSupport')}
                        subtitle={t('settings.supportFeedback.helpSupportDesc')}
                        onPress={() => router.push('/settings/about')}
                    />
                    <SettingsItem
                        icon="information-circle"
                        title={t('settings.aboutMention.title', { defaultValue: 'About' })}
                        subtitle={t('settings.aboutMention.subtitle', { defaultValue: 'Version, build info, debug' })}
                        onPress={() => router.push('/settings/about')}
                    />
                </SettingsGroup>

                {/* Advanced */}
                <SettingsGroup title={t('settings.sections.advanced', { defaultValue: 'Advanced' })}>
                    <SettingsItem
                        icon="link"
                        title={t('settings.data.linkManagement')}
                        subtitle={t('settings.data.linkManagementDesc')}
                        onPress={() => router.push('/settings/links')}
                    />
                    <SettingsItem
                        icon="download-outline"
                        title={t('settings.data.exportData', { defaultValue: 'Export your data' })}
                        subtitle={t('settings.data.requestExportDesc', { defaultValue: 'Download a copy of your posts, likes, and bookmarks' })}
                        onPress={() => router.push('/settings/account')}
                    />
                </SettingsGroup>

                {/* Sign Out */}
                <SettingsGroup>
                    <SettingsItem
                        icon="log-out"
                        title={t("settings.signOut")}
                        subtitle={t("settings.signOutDesc")}
                        onPress={handleSignOut}
                        destructive
                        showChevron={false}
                    />
                </SettingsGroup>
            </Animated.ScrollView>
        </ThemedView>
    );
}
