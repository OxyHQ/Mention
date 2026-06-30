import { useCallback, useEffect, useRef, useMemo } from "react";
import { View, Text, Animated, ScrollView } from "react-native";
import { ThemedView } from "@/components/ThemedView";
import { Header } from "@/components/Header";
import { IconButton } from '@/components/ui/Button';
import { BackArrowIcon } from "@/assets/icons/back-arrow-icon";
import { useAuth, OxySignInButton } from "@oxyhq/services";
import { useTranslation } from "react-i18next";
import { useLayoutScroll } from "@/context/LayoutScrollContext";
import { useRouter } from "expo-router";
import { useSafeBack } from '@/hooks/useSafeBack';
import { useProfileData } from "@/hooks/useProfileData";
import { Avatar } from '@oxyhq/bloom/avatar';
import { Button } from "@/components/ui/Button";
import { SettingsListGroup, SettingsListItem } from '@oxyhq/bloom/settings-list';
import { Loading } from '@oxyhq/bloom/loading';
import { RowIcon } from '@/components/settings/RowIcon';
import { LogoIcon } from "@/assets/logo";
import { confirmDialog } from "@/utils/alerts";
import { createScopedLogger } from "@/lib/logger";
import { useBloomTheme } from '@oxyhq/bloom/theme';
import { useAppearanceStore } from '@/store/appearanceStore';

const logger = createScopedLogger('SettingsScreen');

export default function SettingsScreen() {
    const { t } = useTranslation();
    const router = useRouter();
    const safeBack = useSafeBack();
    const { user, isAuthenticated, showBottomSheet, signOut } = useAuth();
    const { resetTheme } = useBloomTheme();
    const resetAppearance = useAppearanceStore((state) => state.reset);
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
        } catch (error) {
            logger.warn('Sign-out failed; resetting local state and navigating anyway', { error });
        }
        resetAppearance();
        resetTheme();
        router.replace('/');
    };

    return (
        <ThemedView className="flex-1">
            {/* NOT wrapped in <PanelStickyHeader>: settings uses an inner
                Animated.ScrollView (registered to LayoutScroll), NOT the
                document-scroll model the feed screens use, and its header is
                already `disableSticky` (non-sticky, in flow above the inner
                scroller). Adopting PanelStickyHeader here would require changing
                the scroll model, so it is intentionally left as-is. */}
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
            >
                {isAuthenticated && !currentUserProfile ? (
                    <View className="items-center py-4">
                        <Loading />
                    </View>
                ) : isAuthenticated && currentUserProfile ? (
                    <View className="items-center py-4 gap-1">
                        <Avatar
                            source={currentUserProfile.avatar}
                            size={80}
                        />
                        <Text className="text-2xl font-bold text-foreground mt-2" numberOfLines={1}>
                            {currentUserProfile.design.displayName}
                        </Text>
                        <Text className="text-base text-muted-foreground" numberOfLines={1}>
                            @{currentUserProfile.username}
                        </Text>
                        <View className="mt-3">
                            <Button
                                variant="secondary"
                                size="small"
                                onPress={() => showBottomSheet?.('ManageAccount')}
                            >
                                {t('settings.account.manageAccount', { defaultValue: 'Manage account' })}
                            </Button>
                        </View>
                    </View>
                ) : (
                    <View className="items-center px-6 py-6 gap-3">
                        <LogoIcon size={48} className="text-foreground" />
                        <Text className="text-2xl font-bold text-foreground text-center">
                            {t('settings.account.signedOutTitle', { defaultValue: 'Sign in to Mention' })}
                        </Text>
                        <Text className="text-base text-muted-foreground text-center max-w-[320px]">
                            {t('settings.account.signedOutSubtitle', { defaultValue: 'Sign in to access your privacy, notifications, feed, and personalization settings.' })}
                        </Text>
                        <View className="mt-2 w-full max-w-[320px]">
                            <OxySignInButton variant="contained" />
                        </View>
                    </View>
                )}

                {isAuthenticated && (
                    <SettingsListGroup>
                        <SettingsListItem
                            icon={<RowIcon name="eye-off-outline" />}
                            title={t('settings.privacy.title')}
                            description={t('settings.privacy.description', { defaultValue: 'Profile visibility, blocked profiles, hidden words' })}
                            onPress={() => router.push('/settings/privacy')}
                        />
                    </SettingsListGroup>
                )}

                {isAuthenticated && (
                    <SettingsListGroup>
                        <SettingsListItem
                            icon={<RowIcon name="notifications-outline" />}
                            title={t('settings.preferences.notifications')}
                            description={t('settings.preferences.notificationsDesc', { defaultValue: 'Push notifications, email alerts' })}
                            onPress={() => router.push('/settings/notifications')}
                        />
                        <SettingsListItem
                            icon={<RowIcon name="reader-outline" />}
                            title={t('settings.feed.title')}
                            description={t('settings.feed.description', { defaultValue: 'Content preferences, feed algorithm' })}
                            onPress={() => router.push('/settings/feed')}
                        />
                        <SettingsListItem
                            icon={<RowIcon name="cube-outline" />}
                            title={t('settings.node.title', { defaultValue: 'Your Mention node' })}
                            description={t('settings.node.description', { defaultValue: 'Your own copy of your signed posts' })}
                            onPress={() => router.push('/settings/node')}
                        />
                    </SettingsListGroup>
                )}

                <SettingsListGroup>
                    <SettingsListItem
                        icon={<RowIcon name="color-palette-outline" />}
                        title={t('settings.preferences.appearance')}
                        description={t('settings.preferences.appearanceDesc', { defaultValue: 'Theme, colors, display' })}
                        onPress={() => router.push('/settings/appearance')}
                    />
                    <SettingsListItem
                        icon={<RowIcon name="accessibility-outline" />}
                        title={t('settings.accessibility.title', { defaultValue: 'Accessibility' })}
                        description={t('settings.accessibility.description', { defaultValue: 'Haptic feedback, alt text' })}
                        onPress={() => router.push('/settings/accessibility')}
                    />
                    <SettingsListItem
                        icon={<RowIcon name="play-circle-outline" />}
                        title={t('settings.externalMedia.title', { defaultValue: 'External Media Preferences' })}
                        description={t('settings.externalMedia.description', { defaultValue: 'Inline players for YouTube, Spotify, and more' })}
                        onPress={() => router.push('/settings/external-media')}
                    />
                    <SettingsListItem
                        icon={<RowIcon name="chatbubbles-outline" />}
                        title={t('settings.threadPreferences.title', { defaultValue: 'Thread preferences' })}
                        description={t('settings.threadPreferences.description', { defaultValue: 'Reply sorting, thread display' })}
                        onPress={() => router.push('/settings/thread-preferences')}
                    />
                    <SettingsListItem
                        icon={<RowIcon name="language-outline" />}
                        title={t('Language')}
                        description={t('settings.language.description', { defaultValue: 'App display language' })}
                        onPress={() => router.push('/settings/language')}
                    />
                </SettingsListGroup>

                {isAuthenticated && (
                    <SettingsListGroup>
                        <SettingsListItem
                            icon={<RowIcon name="person-outline" />}
                            title={t('settings.preferences.profileCustomization')}
                            description={t('settings.preferences.profileCustomizationDesc', { defaultValue: 'Layout, profile color' })}
                            onPress={() => router.push('/settings/profile-customization')}
                        />
                        <SettingsListItem
                            icon={<RowIcon name="heart-outline" />}
                            title={t('settings.preferences.interests', { defaultValue: 'Your interests' })}
                            description={t('settings.preferences.interestsDesc', { defaultValue: 'Topics and categories you follow' })}
                            onPress={() => router.push('/settings/interests')}
                        />
                    </SettingsListGroup>
                )}

                <SettingsListGroup>
                    <SettingsListItem
                        icon={<RowIcon name="help-circle-outline" />}
                        title={t('settings.supportFeedback.helpSupport')}
                        description={t('settings.supportFeedback.helpSupportDesc')}
                        onPress={() => router.push('/settings/about')}
                    />
                    <SettingsListItem
                        icon={<RowIcon name="information-circle-outline" />}
                        title={t('settings.aboutMention.title', { defaultValue: 'About' })}
                        description={t('settings.aboutMention.description', { defaultValue: 'Version, system info, debug' })}
                        onPress={() => router.push('/settings/about')}
                    />
                </SettingsListGroup>

                {isAuthenticated && (
                    <SettingsListGroup>
                        <SettingsListItem
                            icon={<RowIcon name="log-out-outline" destructive />}
                            title={t("settings.signOut")}
                            onPress={handleSignOut}
                            destructive
                            showChevron={false}
                        />
                    </SettingsListGroup>
                )}
            </Animated.ScrollView>
        </ThemedView>
    );
}
