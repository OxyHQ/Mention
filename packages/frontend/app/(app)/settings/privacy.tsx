import React, { useState, useEffect } from 'react';
import { View, Text, TouchableOpacity, ScrollView } from 'react-native';
import { Loading } from '@/components/ui/Loading';
import { ThemedView } from '@/components/ThemedView';
import { Header } from '@/components/Header';
import { IconButton } from '@/components/ui/Button';
import { BackArrowIcon } from '@/assets/icons/back-arrow-icon';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '@oxyhq/services';
import { useTheme } from '@/hooks/useTheme';
import { useTranslation } from 'react-i18next';
import { authenticatedClient } from '@/utils/api';

const IconComponent = Ionicons as any;

interface PrivacySettings {
    profileVisibility?: 'public' | 'private' | 'followers_only';
    showContactInfo?: boolean;
    allowTags?: boolean;
    allowMentions?: boolean;
    showOnlineStatus?: boolean;
    hideLikeCounts?: boolean;
    hideShareCounts?: boolean;
    hiddenWords?: string[];
    restrictedUsers?: string[];
}

export default function PrivacySettingsScreen() {
    const { t } = useTranslation();
    const { colors } = useTheme();
    const { user } = useAuth();

    const [privacySettings, setPrivacySettings] = useState<PrivacySettings>({});
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        loadPrivacySettings();
    }, []);

    const loadPrivacySettings = async () => {
        try {
            const response = await authenticatedClient.get('/profile/settings/me');
            const settings = response.data;
            setPrivacySettings(settings.privacy || { profileVisibility: 'public' });
            setLoading(false);
        } catch (error) {
            console.error('Error loading privacy settings:', error);
            setPrivacySettings({ profileVisibility: 'public' });
            setLoading(false);
        }
    };

    const updatePrivacySettings = async (updates: Partial<PrivacySettings>) => {
        try {
            const newSettings = { ...privacySettings, ...updates };
            await authenticatedClient.put('/profile/settings', {
                privacy: newSettings
            });
            setPrivacySettings(newSettings);
        } catch (error) {
            console.error('Error updating privacy settings:', error);
        }
    };

    const handlePrivateProfilePress = () => {
        router.push('/settings/privacy/profile-visibility');
    };

    const handleTagsMentionsPress = () => {
        router.push('/settings/privacy/tags-mentions');
    };

    const handleOnlineStatusPress = () => {
        router.push('/settings/privacy/online-status');
    };

    const handleRestrictedProfilesPress = () => {
        router.push('/settings/privacy/restricted');
    };

    const handleBlockedProfilesPress = () => {
        router.push('/settings/privacy/blocked');
    };

    const handleHiddenWordsPress = () => {
        router.push('/settings/privacy/hidden-words');
    };

    const handleHideLikeShareCountsPress = () => {
        router.push('/settings/privacy/hide-counts');
    };

    const getProfileVisibilityText = () => {
        const visibility = privacySettings.profileVisibility || 'public';
        if (visibility === 'private') return t('settings.privacy.private');
        if (visibility === 'followers_only') return t('settings.privacy.followersOnly');
        return t('settings.privacy.public');
    };

    if (loading) {
        return (
            <ThemedView className="flex-1">
                <Header
                    options={{
                        title: t('settings.privacy.title'),
                        leftComponents: [
                            <IconButton variant="icon"
                                key="back"
                                onPress={() => router.back()}
                            >
                                <BackArrowIcon size={20} color={colors.text} />
                            </IconButton>,
                        ],
                    }}
                    hideBottomBorder={true}
                    disableSticky={true}
                />
                <View className="flex-1 justify-center items-center">
                    <Loading size="large" />
                </View>
            </ThemedView>
        );
    }

    return (
        <ThemedView className="flex-1">
            <Header
                options={{
                    title: t('settings.privacy.title'),
                    leftComponents: [
                        <IconButton variant="icon"
                            key="back"
                            onPress={() => router.back()}
                        >
                            <BackArrowIcon size={20} color={colors.text} />
                        </IconButton>,
                    ],
                }}
                hideBottomBorder={true}
                disableSticky={true}
            />

            <ScrollView
                className="flex-1"
                contentContainerClassName="px-4 pt-5 pb-6"
                showsVerticalScrollIndicator={false}
            >
                {/* Privacy settings card */}
                <View className="rounded-2xl border border-border bg-card overflow-hidden">
                    {/* Private profile */}
                    <TouchableOpacity
                        className="flex-row items-center justify-between px-4 pt-[18px] py-4"
                        onPress={handlePrivateProfilePress}
                    >
                        <View className="flex-row items-center flex-1">
                            <View className="mr-3 items-center justify-center">
                                <IconComponent name="lock-closed" size={20} color={colors.text} />
                            </View>
                            <View className="flex-1">
                                <Text className="text-base font-medium text-foreground">
                                    {t('settings.privacy.privateProfile')}
                                </Text>
                            </View>
                        </View>
                        <View className="flex-row items-center gap-2">
                            <Text className="text-sm font-medium text-muted-foreground">
                                {getProfileVisibilityText()}
                            </Text>
                            <IconComponent name="chevron-forward" size={16} color={colors.textTertiary} />
                        </View>
                    </TouchableOpacity>

                    <View className="h-px mx-4 bg-border" />

                    {/* Tags and mentions */}
                    <TouchableOpacity
                        className="flex-row items-center justify-between px-4 py-4"
                        onPress={handleTagsMentionsPress}
                    >
                        <View className="flex-row items-center flex-1">
                            <View className="mr-3 items-center justify-center">
                                <IconComponent name="at" size={20} color={colors.text} />
                            </View>
                            <View className="flex-1">
                                <Text className="text-base font-medium text-foreground">
                                    {t('settings.privacy.tagsAndMentions')}
                                </Text>
                            </View>
                        </View>
                        <IconComponent name="chevron-forward" size={16} color={colors.textTertiary} />
                    </TouchableOpacity>

                    <View className="h-px mx-4 bg-border" />

                    {/* Online status */}
                    <TouchableOpacity
                        className="flex-row items-center justify-between px-4 py-4"
                        onPress={handleOnlineStatusPress}
                    >
                        <View className="flex-row items-center flex-1">
                            <View className="mr-3 items-center justify-center">
                                <IconComponent name="ellipse" size={20} color={colors.text} />
                            </View>
                            <View className="flex-1">
                                <Text className="text-base font-medium text-foreground">
                                    {t('settings.privacy.onlineStatus')}
                                </Text>
                            </View>
                        </View>
                        <IconComponent name="chevron-forward" size={16} color={colors.textTertiary} />
                    </TouchableOpacity>

                    <View className="h-px mx-4 bg-border" />

                    {/* Restricted profiles */}
                    <TouchableOpacity
                        className="flex-row items-center justify-between px-4 py-4"
                        onPress={handleRestrictedProfilesPress}
                    >
                        <View className="flex-row items-center flex-1">
                            <View className="mr-3 items-center justify-center">
                                <IconComponent name="people" size={20} color={colors.text} />
                            </View>
                            <View className="flex-1">
                                <Text className="text-base font-medium text-foreground">
                                    {t('settings.privacy.restrictedProfiles')}
                                </Text>
                            </View>
                        </View>
                        <IconComponent name="chevron-forward" size={16} color={colors.textTertiary} />
                    </TouchableOpacity>

                    <View className="h-px mx-4 bg-border" />

                    {/* Blocked profiles */}
                    <TouchableOpacity
                        className="flex-row items-center justify-between px-4 py-4"
                        onPress={handleBlockedProfilesPress}
                    >
                        <View className="flex-row items-center flex-1">
                            <View className="mr-3 items-center justify-center">
                                <IconComponent name="close-circle" size={20} color={colors.text} />
                            </View>
                            <View className="flex-1">
                                <Text className="text-base font-medium text-foreground">
                                    {t('settings.privacy.blockedProfiles')}
                                </Text>
                            </View>
                        </View>
                        <IconComponent name="chevron-forward" size={16} color={colors.textTertiary} />
                    </TouchableOpacity>

                    <View className="h-px mx-4 bg-border" />

                    {/* Hidden Words */}
                    <TouchableOpacity
                        className="flex-row items-center justify-between px-4 py-4"
                        onPress={handleHiddenWordsPress}
                    >
                        <View className="flex-row items-center flex-1">
                            <View className="mr-3 items-center justify-center">
                                <IconComponent name="eye-off" size={20} color={colors.text} />
                            </View>
                            <View className="flex-1">
                                <Text className="text-base font-medium text-foreground">
                                    {t('settings.privacy.hiddenWords')}
                                </Text>
                            </View>
                        </View>
                        <IconComponent name="chevron-forward" size={16} color={colors.textTertiary} />
                    </TouchableOpacity>

                    <View className="h-px mx-4 bg-border" />

                    {/* Hide like and share counts */}
                    <TouchableOpacity
                        className="flex-row items-center justify-between px-4 py-4 pb-[18px]"
                        onPress={handleHideLikeShareCountsPress}
                    >
                        <View className="flex-row items-center flex-1">
                            <View className="mr-3 items-center justify-center">
                                <IconComponent name="heart-outline" size={20} color={colors.text} />
                            </View>
                            <View className="flex-1">
                                <Text className="text-base font-medium text-foreground">
                                    {t('settings.privacy.hideLikeShareCounts')}
                                </Text>
                            </View>
                        </View>
                        <IconComponent name="chevron-forward" size={16} color={colors.textTertiary} />
                    </TouchableOpacity>
                </View>
            </ScrollView>
        </ThemedView>
    );
}
