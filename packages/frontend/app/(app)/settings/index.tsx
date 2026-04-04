import { useCallback, useEffect, useRef, useMemo } from "react";
import { View, Text, Platform, Animated, ScrollView } from "react-native";
import { ThemedView } from "@/components/ThemedView";
import { Header } from "@/components/Header";
import { IconButton } from '@/components/ui/Button';
import { BackArrowIcon } from "@/assets/icons/back-arrow-icon";
import { useAuth } from "@oxyhq/services";
import { useTranslation } from "react-i18next";
import { useLayoutScroll } from "@/context/LayoutScrollContext";
import { useRouter } from "expo-router";
import { useSafeBack } from '@/hooks/useSafeBack';
import { useProfileData } from "@/hooks/useProfileData";
import { Avatar } from '@oxyhq/bloom/avatar';
import { Button } from "@/components/ui/Button";
import { SettingsItem, SettingsGroup } from "@/components/settings/SettingsItem";
import { confirmDialog } from "@/utils/alerts";
import { Bell } from "@/assets/icons/bell-icon";
import { HeartIcon } from "@/assets/icons/heart-icon";
import { LinkIcon } from "@/assets/icons/link-icon";
import { ProfileIcon } from "@/assets/icons/profile-icon";
import { Gear } from "@/assets/icons/gear-icon";
import { Chat } from "@/assets/icons/chat-icon";
import { Feeds } from "@/assets/icons/feeds-icon";
import { HideIcon } from "@/assets/icons/hide-icon";

export default function SettingsScreen() {
    const { t } = useTranslation();
    const router = useRouter();
    const safeBack = useSafeBack();
    const { user, showBottomSheet, signOut } = useAuth();
    const { data: currentUserProfile } = useProfileData(user?.username);
    const scrollViewRef = useRef<ScrollView>(null);
    const unregisterScrollableRef = useRef<(() => void) | null>(null);
    const { handleScroll, scrollEventThrottle, registerScrollable, createAnimatedScrollHandler } = useLayoutScroll();

    const clearScrollRegistration = useCallback(() => {
        if (unregisterScrollableRef.current) {
            unregisterScrollableRef.current();
            unregisterScrollableRef.current = null;
        }
    }, []);

    const assignScrollViewRef = useCallback((node: ScrollView | null) => {
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

    const handleSignOut = async () => {
        const confirmed = await confirmDialog({
            title: t('settings.signOut'),
            message: t('settings.signOutMessage'),
            okText: t('settings.signOut'),
            cancelText: t('common.cancel'),
            destructive: true,
        });
        if (!confirmed) return;
        try {
            await signOut();
        } catch {
            // Sign-out may fail if session is already invalid; navigate anyway
        }
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
                        <IconButton variant="icon" key="back" onPress={() => safeBack()}>
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
                contentContainerClassName="py-4"
                showsVerticalScrollIndicator={false}
                onScroll={onScroll}
                scrollEventThrottle={scrollEventThrottle}
                {...(Platform.OS === 'web' ? { dataSet: { layoutscroll: 'true' } } : {}) as Record<string, unknown>}
            >
                {/* Centered profile preview */}
                <View className="items-center py-4 gap-1">
                    <Avatar
                        source={currentUserProfile?.avatar || user?.avatar}
                        size={80}
                    />
                    <Text className="text-2xl font-bold text-foreground mt-2" numberOfLines={1}>
                        {displayName}
                    </Text>
                    <Text className="text-base text-muted-foreground" numberOfLines={1}>
                        @{user?.username || 'username'}
                    </Text>
                    <View className="mt-3">
                        <Button
                            variant="secondary"
                            size="small"
                            onPress={() => showBottomSheet?.('AccountSettings')}
                        >
                            {t('settings.account.manageAccount', { defaultValue: 'Manage account' })}
                        </Button>
                    </View>
                </View>

                {/* Privacy */}
                <SettingsGroup>
                    <SettingsItem
                        icon={<HideIcon size={20} className="text-foreground" />}
                        title={t('settings.privacy.title')}
                        description={t('settings.privacy.description', { defaultValue: 'Profile visibility, blocked profiles, hidden words' })}
                        onPress={() => router.push('/settings/privacy')}
                    />
                </SettingsGroup>

                {/* Preferences */}
                <SettingsGroup>
                    <SettingsItem
                        icon={<Bell size={20} className="text-foreground" />}
                        title={t('settings.preferences.notifications')}
                        description={t('settings.preferences.notificationsDesc', { defaultValue: 'Push notifications, email alerts' })}
                        onPress={() => router.push('/settings/notifications')}
                    />
                    <SettingsItem
                        icon={<Feeds size={20} className="text-foreground" />}
                        title={t('settings.feed.title')}
                        description={t('settings.feed.description', { defaultValue: 'Content preferences, feed algorithm' })}
                        onPress={() => router.push('/settings/feed')}
                    />
                    <SettingsItem
                        icon={<Chat size={20} className="text-foreground" />}
                        title={t('settings.threadPreferences.title', { defaultValue: 'Thread preferences' })}
                        description={t('settings.threadPreferences.description', { defaultValue: 'Reply sorting, thread display' })}
                        onPress={() => router.push('/settings/thread-preferences')}
                    />
                </SettingsGroup>

                {/* Personalization */}
                <SettingsGroup>
                    <SettingsItem
                        icon="color-palette"
                        title={t('settings.preferences.appearance')}
                        description={t('settings.preferences.appearanceDesc', { defaultValue: 'Theme, colors, display' })}
                        onPress={() => router.push('/settings/appearance')}
                    />
                    <SettingsItem
                        icon="accessibility"
                        title={t('settings.accessibility.title', { defaultValue: 'Accessibility' })}
                        description={t('settings.accessibility.description', { defaultValue: 'Haptic feedback, alt text' })}
                        onPress={() => router.push('/settings/accessibility')}
                    />
                    <SettingsItem
                        icon="language"
                        title={t('Language')}
                        description={t('settings.language.description', { defaultValue: 'App display language' })}
                        onPress={() => router.push('/settings/language')}
                    />
                </SettingsGroup>

                {/* Profile */}
                <SettingsGroup>
                    <SettingsItem
                        icon={<ProfileIcon size={20} className="text-foreground" />}
                        title={t('settings.preferences.profileCustomization')}
                        description={t('settings.preferences.profileCustomizationDesc', { defaultValue: 'Layout, profile color' })}
                        onPress={() => router.push('/settings/profile-customization')}
                    />
                    <SettingsItem
                        icon={<HeartIcon size={20} className="text-foreground" />}
                        title={t('settings.preferences.interests', { defaultValue: 'Your interests' })}
                        description={t('settings.preferences.interestsDesc', { defaultValue: 'Topics and categories you follow' })}
                        onPress={() => router.push('/settings/interests')}
                    />
                </SettingsGroup>

                {/* Support */}
                <SettingsGroup>
                    <SettingsItem
                        icon={<LinkIcon size={20} className="text-foreground" />}
                        title={t('settings.data.linkManagement')}
                        description={t('settings.data.linkManagementDesc', { defaultValue: 'Link previews and cache' })}
                        onPress={() => router.push('/settings/links')}
                    />
                    <SettingsItem
                        icon="help-circle"
                        title={t('settings.supportFeedback.helpSupport')}
                        description={t('settings.supportFeedback.helpSupportDesc')}
                        onPress={() => router.push('/settings/about')}
                    />
                    <SettingsItem
                        icon={<Gear size={20} className="text-foreground" />}
                        title={t('settings.aboutMention.title', { defaultValue: 'About' })}
                        description={t('settings.aboutMention.description', { defaultValue: 'Version, system info, debug' })}
                        onPress={() => router.push('/settings/about')}
                    />
                </SettingsGroup>

                {/* Sign out */}
                <SettingsGroup>
                    <SettingsItem
                        title={t("settings.signOut")}
                        onPress={handleSignOut}
                        destructive
                        showChevron={false}
                    />
                </SettingsGroup>
            </Animated.ScrollView>
        </ThemedView>
    );
}
