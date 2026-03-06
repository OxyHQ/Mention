import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, StyleSheet, ScrollView } from 'react-native';
import { Loading } from '@/components/ui/Loading';
import { ThemedView } from '@/components/ThemedView';
import { Header } from '@/components/Header';
import { IconButton } from '@/components/ui/Button';
import { BackArrowIcon } from '@/assets/icons/back-arrow-icon';
import { Toggle } from '@/components/Toggle';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@/hooks/useTheme';
import { useTranslation } from 'react-i18next';
import { authenticatedClient } from '@/utils/api';
import { toast } from 'sonner';

const IconComponent = Ionicons as any;

interface NotificationPreferences {
    pushEnabled: boolean;
    emailEnabled: boolean;
    likes: boolean;
    reposts: boolean;
    follows: boolean;
    mentions: boolean;
    replies: boolean;
    quotes: boolean;
}

const DEFAULT_PREFS: NotificationPreferences = {
    pushEnabled: true,
    emailEnabled: false,
    likes: true,
    reposts: true,
    follows: true,
    mentions: true,
    replies: true,
    quotes: true,
};

export default function NotificationSettingsScreen() {
    const { t } = useTranslation();
    const theme = useTheme();

    const [prefs, setPrefs] = useState<NotificationPreferences>(DEFAULT_PREFS);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        loadPreferences();
    }, []);

    const loadPreferences = async () => {
        try {
            const response = await authenticatedClient.get('/profile/settings/me');
            const settings = response.data;
            if (settings.notificationPreferences) {
                setPrefs({ ...DEFAULT_PREFS, ...settings.notificationPreferences });
            }
        } catch (error) {
            console.error('Error loading notification preferences:', error);
        } finally {
            setLoading(false);
        }
    };

    const updatePreference = useCallback(async (key: keyof NotificationPreferences, value: boolean) => {
        const previous = prefs;
        const updated = { ...prefs, [key]: value };
        setPrefs(updated);

        try {
            setSaving(true);
            await authenticatedClient.put('/profile/settings', {
                notificationPreferences: { [key]: value },
            });
        } catch (error) {
            console.error('Error updating notification preferences:', error);
            setPrefs(previous);
            toast.error(
                t('settings.notifications.saveError', {
                    defaultValue: 'Failed to save notification preference',
                }),
            );
        } finally {
            setSaving(false);
        }
    }, [prefs, t]);

    if (loading) {
        return (
            <ThemedView style={styles.container}>
                <Header
                    options={{
                        title: t('settings.notifications.title', { defaultValue: 'Notifications' }),
                        leftComponents: [
                            <IconButton variant="icon" key="back" onPress={() => router.back()}>
                                <BackArrowIcon size={20} color={theme.colors.text} />
                            </IconButton>,
                        ],
                    }}
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
                    title: t('settings.notifications.title', { defaultValue: 'Notifications' }),
                    leftComponents: [
                        <IconButton variant="icon" key="back" onPress={() => router.back()}>
                            <BackArrowIcon size={20} color={theme.colors.text} />
                        </IconButton>,
                    ],
                }}
                hideBottomBorder={true}
            />

            <ScrollView
                style={styles.scrollView}
                contentContainerStyle={styles.content}
                showsVerticalScrollIndicator={false}
            >
                {/* Global toggles */}
                <View style={styles.section}>
                    <Text style={[styles.sectionTitle, { color: theme.colors.text }]}>
                        {t('settings.notifications.sections.general', { defaultValue: 'General' })}
                    </Text>

                    <View style={[styles.settingsCard, { backgroundColor: theme.colors.card, borderColor: theme.colors.border }]}>
                        <View style={[styles.settingItem, styles.firstSettingItem]}>
                            <View style={styles.settingInfo}>
                                <View style={styles.settingIcon}>
                                    <IconComponent name="notifications" size={20} color={theme.colors.textSecondary} />
                                </View>
                                <View style={styles.settingTextContainer}>
                                    <Text style={[styles.settingLabel, { color: theme.colors.text }]}>
                                        {t('settings.notifications.push', { defaultValue: 'Push notifications' })}
                                    </Text>
                                    <Text style={[styles.settingDescription, { color: theme.colors.textSecondary }]}>
                                        {t('settings.notifications.pushDesc', { defaultValue: 'Receive push notifications on your device' })}
                                    </Text>
                                </View>
                            </View>
                            <Toggle value={prefs.pushEnabled} onValueChange={(v) => updatePreference('pushEnabled', v)} />
                        </View>

                        <View style={[styles.divider, { backgroundColor: theme.colors.border }]} />

                        <View style={[styles.settingItem, styles.lastSettingItem]}>
                            <View style={styles.settingInfo}>
                                <View style={styles.settingIcon}>
                                    <IconComponent name="mail" size={20} color={theme.colors.textSecondary} />
                                </View>
                                <View style={styles.settingTextContainer}>
                                    <Text style={[styles.settingLabel, { color: theme.colors.text }]}>
                                        {t('settings.notifications.email', { defaultValue: 'Email notifications' })}
                                    </Text>
                                    <Text style={[styles.settingDescription, { color: theme.colors.textSecondary }]}>
                                        {t('settings.notifications.emailDesc', { defaultValue: 'Receive email summaries of your notifications' })}
                                    </Text>
                                </View>
                            </View>
                            <Toggle value={prefs.emailEnabled} onValueChange={(v) => updatePreference('emailEnabled', v)} />
                        </View>
                    </View>
                </View>

                {/* Per-type toggles */}
                <View style={styles.section}>
                    <Text style={[styles.sectionTitle, { color: theme.colors.text }]}>
                        {t('settings.notifications.sections.types', { defaultValue: 'Notification types' })}
                    </Text>

                    <View style={[styles.settingsCard, { backgroundColor: theme.colors.card, borderColor: theme.colors.border }]}>
                        {/* Likes */}
                        <View style={[styles.settingItem, styles.firstSettingItem]}>
                            <View style={styles.settingInfo}>
                                <View style={styles.settingIcon}>
                                    <IconComponent name="heart" size={20} color={theme.colors.textSecondary} />
                                </View>
                                <View style={styles.settingTextContainer}>
                                    <Text style={[styles.settingLabel, { color: theme.colors.text }]}>
                                        {t('settings.notifications.likes', { defaultValue: 'Likes' })}
                                    </Text>
                                    <Text style={[styles.settingDescription, { color: theme.colors.textSecondary }]}>
                                        {t('settings.notifications.likesDesc', { defaultValue: 'When someone likes your post' })}
                                    </Text>
                                </View>
                            </View>
                            <Toggle value={prefs.likes} onValueChange={(v) => updatePreference('likes', v)} />
                        </View>

                        <View style={[styles.divider, { backgroundColor: theme.colors.border }]} />

                        {/* Reposts */}
                        <View style={styles.settingItem}>
                            <View style={styles.settingInfo}>
                                <View style={styles.settingIcon}>
                                    <IconComponent name="repeat" size={20} color={theme.colors.textSecondary} />
                                </View>
                                <View style={styles.settingTextContainer}>
                                    <Text style={[styles.settingLabel, { color: theme.colors.text }]}>
                                        {t('settings.notifications.reposts', { defaultValue: 'Reposts' })}
                                    </Text>
                                    <Text style={[styles.settingDescription, { color: theme.colors.textSecondary }]}>
                                        {t('settings.notifications.repostsDesc', { defaultValue: 'When someone reposts your post' })}
                                    </Text>
                                </View>
                            </View>
                            <Toggle value={prefs.reposts} onValueChange={(v) => updatePreference('reposts', v)} />
                        </View>

                        <View style={[styles.divider, { backgroundColor: theme.colors.border }]} />

                        {/* Followers */}
                        <View style={styles.settingItem}>
                            <View style={styles.settingInfo}>
                                <View style={styles.settingIcon}>
                                    <IconComponent name="person-add" size={20} color={theme.colors.textSecondary} />
                                </View>
                                <View style={styles.settingTextContainer}>
                                    <Text style={[styles.settingLabel, { color: theme.colors.text }]}>
                                        {t('settings.notifications.follows', { defaultValue: 'New followers' })}
                                    </Text>
                                    <Text style={[styles.settingDescription, { color: theme.colors.textSecondary }]}>
                                        {t('settings.notifications.followsDesc', { defaultValue: 'When someone follows you' })}
                                    </Text>
                                </View>
                            </View>
                            <Toggle value={prefs.follows} onValueChange={(v) => updatePreference('follows', v)} />
                        </View>

                        <View style={[styles.divider, { backgroundColor: theme.colors.border }]} />

                        {/* Mentions */}
                        <View style={styles.settingItem}>
                            <View style={styles.settingInfo}>
                                <View style={styles.settingIcon}>
                                    <IconComponent name="at" size={20} color={theme.colors.textSecondary} />
                                </View>
                                <View style={styles.settingTextContainer}>
                                    <Text style={[styles.settingLabel, { color: theme.colors.text }]}>
                                        {t('settings.notifications.mentions', { defaultValue: 'Mentions' })}
                                    </Text>
                                    <Text style={[styles.settingDescription, { color: theme.colors.textSecondary }]}>
                                        {t('settings.notifications.mentionsDesc', { defaultValue: 'When someone mentions you in a post' })}
                                    </Text>
                                </View>
                            </View>
                            <Toggle value={prefs.mentions} onValueChange={(v) => updatePreference('mentions', v)} />
                        </View>

                        <View style={[styles.divider, { backgroundColor: theme.colors.border }]} />

                        {/* Replies */}
                        <View style={styles.settingItem}>
                            <View style={styles.settingInfo}>
                                <View style={styles.settingIcon}>
                                    <IconComponent name="chatbubble" size={20} color={theme.colors.textSecondary} />
                                </View>
                                <View style={styles.settingTextContainer}>
                                    <Text style={[styles.settingLabel, { color: theme.colors.text }]}>
                                        {t('settings.notifications.replies', { defaultValue: 'Replies' })}
                                    </Text>
                                    <Text style={[styles.settingDescription, { color: theme.colors.textSecondary }]}>
                                        {t('settings.notifications.repliesDesc', { defaultValue: 'When someone replies to your post' })}
                                    </Text>
                                </View>
                            </View>
                            <Toggle value={prefs.replies} onValueChange={(v) => updatePreference('replies', v)} />
                        </View>

                        <View style={[styles.divider, { backgroundColor: theme.colors.border }]} />

                        {/* Quote posts */}
                        <View style={[styles.settingItem, styles.lastSettingItem]}>
                            <View style={styles.settingInfo}>
                                <View style={styles.settingIcon}>
                                    <IconComponent name="chatbox-ellipses" size={20} color={theme.colors.textSecondary} />
                                </View>
                                <View style={styles.settingTextContainer}>
                                    <Text style={[styles.settingLabel, { color: theme.colors.text }]}>
                                        {t('settings.notifications.quotes', { defaultValue: 'Quote posts' })}
                                    </Text>
                                    <Text style={[styles.settingDescription, { color: theme.colors.textSecondary }]}>
                                        {t('settings.notifications.quotesDesc', { defaultValue: 'When someone quotes your post' })}
                                    </Text>
                                </View>
                            </View>
                            <Toggle value={prefs.quotes} onValueChange={(v) => updatePreference('quotes', v)} />
                        </View>
                    </View>
                </View>
            </ScrollView>
        </ThemedView>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
    },
    loadingContainer: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
    },
    scrollView: {
        flex: 1,
    },
    content: {
        paddingHorizontal: 16,
        paddingTop: 20,
        paddingBottom: 24,
    },
    section: {
        marginBottom: 32,
    },
    sectionTitle: {
        fontSize: 13,
        fontWeight: '600',
        textTransform: 'uppercase',
        letterSpacing: 0.5,
        marginBottom: 12,
        paddingHorizontal: 4,
    },
    settingsCard: {
        borderRadius: 16,
        borderWidth: 1,
        overflow: 'hidden',
    },
    settingItem: {
        paddingHorizontal: 16,
        paddingVertical: 16,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
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
        marginRight: 12,
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
        marginBottom: 2,
    },
    settingDescription: {
        fontSize: 14,
    },
});
