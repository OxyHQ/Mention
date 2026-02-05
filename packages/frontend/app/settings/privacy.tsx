import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView } from 'react-native';
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
    const theme = useTheme();
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
            <ThemedView style={styles.container}>
                <Header
                    options={{
                        title: t('settings.privacy.title'),
                        leftComponents: [
                            <IconButton variant="icon"
                                key="back"
                                onPress={() => router.back()}
                            >
                                <BackArrowIcon size={20} color={theme.colors.text} />
                            </IconButton>,
                        ],
                    }}
                    hideBottomBorder={true}
                    disableSticky={true}
                />
                <View style={styles.loadingContainer}>
                    <Loading size="large" />
                </View>
            </ThemedView>
        );
    }

    return (
        <ThemedView style={styles.container}>
            <Header
                options={{
                    title: t('settings.privacy.title'),
                    leftComponents: [
                        <IconButton variant="icon"
                            key="back"
                            onPress={() => router.back()}
                        >
                            <BackArrowIcon size={20} color={theme.colors.text} />
                        </IconButton>,
                    ],
                }}
                hideBottomBorder={true}
                disableSticky={true}
            />

            <ScrollView 
                style={styles.scrollView}
                contentContainerStyle={styles.content}
                showsVerticalScrollIndicator={false}
            >
                {/* Privacy settings card */}
                <View style={[styles.settingsCard, { backgroundColor: theme.colors.card, borderColor: theme.colors.border }]}>
                    {/* Private profile */}
                    <TouchableOpacity
                        style={[styles.settingItem, styles.firstSettingItem]}
                        onPress={handlePrivateProfilePress}
                    >
                        <View style={styles.settingInfo}>
                            <View style={styles.settingIcon}>
                                <IconComponent name="lock-closed" size={20} color={theme.colors.text} />
                            </View>
                            <View style={styles.settingTextContainer}>
                                <Text style={[styles.settingLabel, { color: theme.colors.text }]}>
                                    {t('settings.privacy.privateProfile')}
                                </Text>
                            </View>
                        </View>
                        <View style={styles.settingRight}>
                            <Text style={[styles.settingValue, { color: theme.colors.textSecondary }]}>
                                {getProfileVisibilityText()}
                            </Text>
                            <IconComponent name="chevron-forward" size={16} color={theme.colors.textTertiary} />
                        </View>
                    </TouchableOpacity>

                    <View style={[styles.divider, { backgroundColor: theme.colors.border }]} />

                    {/* Tags and mentions */}
                    <TouchableOpacity
                        style={styles.settingItem}
                        onPress={handleTagsMentionsPress}
                    >
                        <View style={styles.settingInfo}>
                            <View style={styles.settingIcon}>
                                <IconComponent name="at" size={20} color={theme.colors.text} />
                            </View>
                            <View style={styles.settingTextContainer}>
                                <Text style={[styles.settingLabel, { color: theme.colors.text }]}>
                                    {t('settings.privacy.tagsAndMentions')}
                                </Text>
                            </View>
                        </View>
                        <IconComponent name="chevron-forward" size={16} color={theme.colors.textTertiary} />
                    </TouchableOpacity>

                    <View style={[styles.divider, { backgroundColor: theme.colors.border }]} />

                    {/* Online status */}
                    <TouchableOpacity
                        style={styles.settingItem}
                        onPress={handleOnlineStatusPress}
                    >
                        <View style={styles.settingInfo}>
                            <View style={styles.settingIcon}>
                                <IconComponent name="ellipse" size={20} color={theme.colors.text} />
                            </View>
                            <View style={styles.settingTextContainer}>
                                <Text style={[styles.settingLabel, { color: theme.colors.text }]}>
                                    {t('settings.privacy.onlineStatus')}
                                </Text>
                            </View>
                        </View>
                        <IconComponent name="chevron-forward" size={16} color={theme.colors.textTertiary} />
                    </TouchableOpacity>

                    <View style={[styles.divider, { backgroundColor: theme.colors.border }]} />

                    {/* Restricted profiles */}
                    <TouchableOpacity
                        style={styles.settingItem}
                        onPress={handleRestrictedProfilesPress}
                    >
                        <View style={styles.settingInfo}>
                            <View style={styles.settingIcon}>
                                <IconComponent name="people" size={20} color={theme.colors.text} />
                            </View>
                            <View style={styles.settingTextContainer}>
                                <Text style={[styles.settingLabel, { color: theme.colors.text }]}>
                                    {t('settings.privacy.restrictedProfiles')}
                                </Text>
                            </View>
                        </View>
                        <IconComponent name="chevron-forward" size={16} color={theme.colors.textTertiary} />
                    </TouchableOpacity>

                    <View style={[styles.divider, { backgroundColor: theme.colors.border }]} />

                    {/* Blocked profiles */}
                    <TouchableOpacity
                        style={styles.settingItem}
                        onPress={handleBlockedProfilesPress}
                    >
                        <View style={styles.settingInfo}>
                            <View style={styles.settingIcon}>
                                <IconComponent name="close-circle" size={20} color={theme.colors.text} />
                            </View>
                            <View style={styles.settingTextContainer}>
                                <Text style={[styles.settingLabel, { color: theme.colors.text }]}>
                                    {t('settings.privacy.blockedProfiles')}
                                </Text>
                            </View>
                        </View>
                        <IconComponent name="chevron-forward" size={16} color={theme.colors.textTertiary} />
                    </TouchableOpacity>

                    <View style={[styles.divider, { backgroundColor: theme.colors.border }]} />

                    {/* Hidden Words */}
                    <TouchableOpacity
                        style={styles.settingItem}
                        onPress={handleHiddenWordsPress}
                    >
                        <View style={styles.settingInfo}>
                            <View style={styles.settingIcon}>
                                <IconComponent name="eye-off" size={20} color={theme.colors.text} />
                            </View>
                            <View style={styles.settingTextContainer}>
                                <Text style={[styles.settingLabel, { color: theme.colors.text }]}>
                                    {t('settings.privacy.hiddenWords')}
                                </Text>
                            </View>
                        </View>
                        <IconComponent name="chevron-forward" size={16} color={theme.colors.textTertiary} />
                    </TouchableOpacity>

                    <View style={[styles.divider, { backgroundColor: theme.colors.border }]} />

                    {/* Hide like and share counts */}
                    <TouchableOpacity
                        style={[styles.settingItem, styles.lastSettingItem]}
                        onPress={handleHideLikeShareCountsPress}
                    >
                        <View style={styles.settingInfo}>
                            <View style={styles.settingIcon}>
                                <IconComponent name="heart-outline" size={20} color={theme.colors.text} />
                            </View>
                            <View style={styles.settingTextContainer}>
                                <Text style={[styles.settingLabel, { color: theme.colors.text }]}>
                                    {t('settings.privacy.hideLikeShareCounts')}
                                </Text>
                            </View>
                        </View>
                        <IconComponent name="chevron-forward" size={16} color={theme.colors.textTertiary} />
                    </TouchableOpacity>
                </View>
            </ScrollView>
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
        paddingHorizontal: 16,
        paddingTop: 20,
        paddingBottom: 24,
    },
    settingsCard: {
        borderRadius: 16,
        borderWidth: 1,
        overflow: 'hidden',
    },
    settingItem: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: 16,
        paddingVertical: 16,
    },
    firstSettingItem: {
        paddingTop: 18,
    },
    lastSettingItem: {
        paddingBottom: 18,
    },
    divider: {
        height: 1,
        marginHorizontal: 16,
    },
    settingInfo: {
        flexDirection: 'row',
        alignItems: 'center',
        flex: 1,
    },
    settingIcon: {
        marginRight: 12,
        alignItems: 'center',
        justifyContent: 'center',
    },
    settingTextContainer: {
        flex: 1,
    },
    settingLabel: {
        fontSize: 16,
        fontWeight: '500',
    },
    settingRight: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    settingValue: {
        fontSize: 14,
        fontWeight: '500',
    },
    loadingContainer: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
    },
});

