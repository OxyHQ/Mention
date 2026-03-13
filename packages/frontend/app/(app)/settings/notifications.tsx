import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, ScrollView } from 'react-native';
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
    const { colors } = useTheme();

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
            <ThemedView className="flex-1">
                <Header
                    options={{
                        title: t('settings.notifications.title', { defaultValue: 'Notifications' }),
                        leftComponents: [
                            <IconButton variant="icon" key="back" onPress={() => router.back()}>
                                <BackArrowIcon size={20} color={colors.text} />
                            </IconButton>,
                        ],
                    }}
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
                    title: t('settings.notifications.title', { defaultValue: 'Notifications' }),
                    leftComponents: [
                        <IconButton variant="icon" key="back" onPress={() => router.back()}>
                            <BackArrowIcon size={20} color={colors.text} />
                        </IconButton>,
                    ],
                }}
                hideBottomBorder={true}
            />

            <ScrollView
                className="flex-1"
                contentContainerClassName="px-4 pt-5 pb-6"
                showsVerticalScrollIndicator={false}
            >
                {/* Global toggles */}
                <View className="mb-8">
                    <Text className="text-[13px] font-semibold uppercase tracking-wide mb-3 px-1 text-foreground">
                        {t('settings.notifications.sections.general', { defaultValue: 'General' })}
                    </Text>

                    <View className="rounded-2xl border border-border bg-card overflow-hidden">
                        <View className="px-4 pt-[18px] py-4 flex-row items-center justify-between">
                            <View className="flex-row items-center flex-1 mr-3">
                                <View className="mr-3 items-center justify-center">
                                    <IconComponent name="notifications" size={20} color={colors.textSecondary} />
                                </View>
                                <View className="flex-1">
                                    <Text className="text-base font-medium mb-0.5 text-foreground">
                                        {t('settings.notifications.push', { defaultValue: 'Push notifications' })}
                                    </Text>
                                    <Text className="text-sm text-muted-foreground">
                                        {t('settings.notifications.pushDesc', { defaultValue: 'Receive push notifications on your device' })}
                                    </Text>
                                </View>
                            </View>
                            <Toggle value={prefs.pushEnabled} onValueChange={(v) => updatePreference('pushEnabled', v)} />
                        </View>

                        <View className="h-px mx-4 bg-border" />

                        <View className="px-4 py-4 pb-[18px] flex-row items-center justify-between">
                            <View className="flex-row items-center flex-1 mr-3">
                                <View className="mr-3 items-center justify-center">
                                    <IconComponent name="mail" size={20} color={colors.textSecondary} />
                                </View>
                                <View className="flex-1">
                                    <Text className="text-base font-medium mb-0.5 text-foreground">
                                        {t('settings.notifications.email', { defaultValue: 'Email notifications' })}
                                    </Text>
                                    <Text className="text-sm text-muted-foreground">
                                        {t('settings.notifications.emailDesc', { defaultValue: 'Receive email summaries of your notifications' })}
                                    </Text>
                                </View>
                            </View>
                            <Toggle value={prefs.emailEnabled} onValueChange={(v) => updatePreference('emailEnabled', v)} />
                        </View>
                    </View>
                </View>

                {/* Per-type toggles */}
                <View className="mb-8">
                    <Text className="text-[13px] font-semibold uppercase tracking-wide mb-3 px-1 text-foreground">
                        {t('settings.notifications.sections.types', { defaultValue: 'Notification types' })}
                    </Text>

                    <View className="rounded-2xl border border-border bg-card overflow-hidden">
                        {/* Likes */}
                        <View className="px-4 pt-[18px] py-4 flex-row items-center justify-between">
                            <View className="flex-row items-center flex-1 mr-3">
                                <View className="mr-3 items-center justify-center">
                                    <IconComponent name="heart" size={20} color={colors.textSecondary} />
                                </View>
                                <View className="flex-1">
                                    <Text className="text-base font-medium mb-0.5 text-foreground">
                                        {t('settings.notifications.likes', { defaultValue: 'Likes' })}
                                    </Text>
                                    <Text className="text-sm text-muted-foreground">
                                        {t('settings.notifications.likesDesc', { defaultValue: 'When someone likes your post' })}
                                    </Text>
                                </View>
                            </View>
                            <Toggle value={prefs.likes} onValueChange={(v) => updatePreference('likes', v)} />
                        </View>

                        <View className="h-px mx-4 bg-border" />

                        {/* Reposts */}
                        <View className="px-4 py-4 flex-row items-center justify-between">
                            <View className="flex-row items-center flex-1 mr-3">
                                <View className="mr-3 items-center justify-center">
                                    <IconComponent name="repeat" size={20} color={colors.textSecondary} />
                                </View>
                                <View className="flex-1">
                                    <Text className="text-base font-medium mb-0.5 text-foreground">
                                        {t('settings.notifications.reposts', { defaultValue: 'Reposts' })}
                                    </Text>
                                    <Text className="text-sm text-muted-foreground">
                                        {t('settings.notifications.repostsDesc', { defaultValue: 'When someone reposts your post' })}
                                    </Text>
                                </View>
                            </View>
                            <Toggle value={prefs.reposts} onValueChange={(v) => updatePreference('reposts', v)} />
                        </View>

                        <View className="h-px mx-4 bg-border" />

                        {/* Followers */}
                        <View className="px-4 py-4 flex-row items-center justify-between">
                            <View className="flex-row items-center flex-1 mr-3">
                                <View className="mr-3 items-center justify-center">
                                    <IconComponent name="person-add" size={20} color={colors.textSecondary} />
                                </View>
                                <View className="flex-1">
                                    <Text className="text-base font-medium mb-0.5 text-foreground">
                                        {t('settings.notifications.follows', { defaultValue: 'New followers' })}
                                    </Text>
                                    <Text className="text-sm text-muted-foreground">
                                        {t('settings.notifications.followsDesc', { defaultValue: 'When someone follows you' })}
                                    </Text>
                                </View>
                            </View>
                            <Toggle value={prefs.follows} onValueChange={(v) => updatePreference('follows', v)} />
                        </View>

                        <View className="h-px mx-4 bg-border" />

                        {/* Mentions */}
                        <View className="px-4 py-4 flex-row items-center justify-between">
                            <View className="flex-row items-center flex-1 mr-3">
                                <View className="mr-3 items-center justify-center">
                                    <IconComponent name="at" size={20} color={colors.textSecondary} />
                                </View>
                                <View className="flex-1">
                                    <Text className="text-base font-medium mb-0.5 text-foreground">
                                        {t('settings.notifications.mentions', { defaultValue: 'Mentions' })}
                                    </Text>
                                    <Text className="text-sm text-muted-foreground">
                                        {t('settings.notifications.mentionsDesc', { defaultValue: 'When someone mentions you in a post' })}
                                    </Text>
                                </View>
                            </View>
                            <Toggle value={prefs.mentions} onValueChange={(v) => updatePreference('mentions', v)} />
                        </View>

                        <View className="h-px mx-4 bg-border" />

                        {/* Replies */}
                        <View className="px-4 py-4 flex-row items-center justify-between">
                            <View className="flex-row items-center flex-1 mr-3">
                                <View className="mr-3 items-center justify-center">
                                    <IconComponent name="chatbubble" size={20} color={colors.textSecondary} />
                                </View>
                                <View className="flex-1">
                                    <Text className="text-base font-medium mb-0.5 text-foreground">
                                        {t('settings.notifications.replies', { defaultValue: 'Replies' })}
                                    </Text>
                                    <Text className="text-sm text-muted-foreground">
                                        {t('settings.notifications.repliesDesc', { defaultValue: 'When someone replies to your post' })}
                                    </Text>
                                </View>
                            </View>
                            <Toggle value={prefs.replies} onValueChange={(v) => updatePreference('replies', v)} />
                        </View>

                        <View className="h-px mx-4 bg-border" />

                        {/* Quote posts */}
                        <View className="px-4 py-4 pb-[18px] flex-row items-center justify-between">
                            <View className="flex-row items-center flex-1 mr-3">
                                <View className="mr-3 items-center justify-center">
                                    <IconComponent name="chatbox-ellipses" size={20} color={colors.textSecondary} />
                                </View>
                                <View className="flex-1">
                                    <Text className="text-base font-medium mb-0.5 text-foreground">
                                        {t('settings.notifications.quotes', { defaultValue: 'Quote posts' })}
                                    </Text>
                                    <Text className="text-sm text-muted-foreground">
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
