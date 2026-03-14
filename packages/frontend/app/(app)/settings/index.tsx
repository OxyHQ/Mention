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
import { useProfileData } from "@/hooks/useProfileData";
import Avatar from "@/components/Avatar";
import { SettingsItem, SettingsGroup } from "@/components/settings/SettingsItem";
import { confirmDialog } from "@/utils/alerts";

export default function SettingsScreen() {
    const { t } = useTranslation();
    const router = useRouter();
    const { user } = useAuth();
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
                </View>

                {/* Account */}
                <SettingsGroup>
                    <SettingsItem
                        icon="person"
                        title={t('settings.account.title', { defaultValue: 'Account' })}
                        onPress={() => router.push('/settings/account')}
                    />
                    <SettingsItem
                        icon="lock-closed"
                        title={t('settings.privacy.title')}
                        onPress={() => router.push('/settings/privacy')}
                    />
                </SettingsGroup>

                {/* Preferences */}
                <SettingsGroup>
                    <SettingsItem
                        icon="notifications"
                        title={t('settings.preferences.notifications')}
                        onPress={() => router.push('/settings/notifications')}
                    />
                    <SettingsItem
                        icon="newspaper-outline"
                        title={t('settings.feed.title')}
                        onPress={() => router.push('/settings/feed')}
                    />
                    <SettingsItem
                        icon="chatbubbles-outline"
                        title={t('settings.threadPreferences.title', { defaultValue: 'Thread preferences' })}
                        onPress={() => router.push('/settings/thread-preferences')}
                    />
                </SettingsGroup>

                {/* Personalization */}
                <SettingsGroup>
                    <SettingsItem
                        icon="color-palette"
                        title={t('settings.preferences.appearance')}
                        onPress={() => router.push('/settings/appearance')}
                    />
                    <SettingsItem
                        icon="accessibility"
                        title={t('settings.accessibility.title', { defaultValue: 'Accessibility' })}
                        onPress={() => router.push('/settings/accessibility')}
                    />
                    <SettingsItem
                        icon="language"
                        title={t('Language')}
                        onPress={() => router.push('/settings/language')}
                    />
                </SettingsGroup>

                {/* Profile */}
                <SettingsGroup>
                    <SettingsItem
                        icon="person-circle-outline"
                        title={t('settings.preferences.profileCustomization')}
                        onPress={() => router.push('/settings/profile-customization')}
                    />
                    <SettingsItem
                        icon="heart-outline"
                        title={t('settings.preferences.interests', { defaultValue: 'Your interests' })}
                        onPress={() => router.push('/settings/interests')}
                    />
                </SettingsGroup>

                {/* Support */}
                <SettingsGroup>
                    <SettingsItem
                        icon="link"
                        title={t('settings.data.linkManagement')}
                        onPress={() => router.push('/settings/links')}
                    />
                    <SettingsItem
                        icon="help-circle"
                        title={t('settings.supportFeedback.helpSupport')}
                        onPress={() => router.push('/settings/about')}
                    />
                    <SettingsItem
                        icon="information-circle"
                        title={t('settings.aboutMention.title', { defaultValue: 'About' })}
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
