import React, { useState, useEffect, useCallback } from 'react';
import { View, ScrollView } from 'react-native';
import { Loading } from '@oxyhq/bloom/loading';
import { ThemedView } from '@/components/ThemedView';
import { Header } from '@/components/Header';
import { IconButton } from '@/components/ui/Button';
import { BackArrowIcon } from '@/assets/icons/back-arrow-icon';
import { Toggle } from '@/components/Toggle';
import { useTranslation } from 'react-i18next';
import { useSafeBack } from '@/hooks/useSafeBack';
import { authenticatedClient } from '@/utils/api';
import { toast } from 'sonner';
import { SettingsItem, SettingsGroup } from '@/components/settings/SettingsItem';

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
    const safeBack = useSafeBack();

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
                            <IconButton variant="icon" key="back" onPress={() => safeBack()}>
                                <BackArrowIcon size={20} className="text-foreground" />
                            </IconButton>,
                        ],
                    }}
                    hideBottomBorder
                    disableSticky
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
                        <IconButton variant="icon" key="back" onPress={() => safeBack()}>
                            <BackArrowIcon size={20} className="text-foreground" />
                        </IconButton>,
                    ],
                    rightComponents: saving ? [
                        <View key="saving" className="pr-2">
                            <Loading variant="inline" size="small" />
                        </View>,
                    ] : [],
                }}
                hideBottomBorder
                disableSticky
            />

            <ScrollView
                className="flex-1"
                contentContainerClassName="py-2"
                showsVerticalScrollIndicator={false}
            >
                <SettingsGroup title={t('settings.notifications.sections.general', { defaultValue: 'General' })}>
                    <SettingsItem
                        icon="notifications"
                        title={t('settings.notifications.push', { defaultValue: 'Push notifications' })}
                        description={t('settings.notifications.pushDesc', { defaultValue: 'Receive push notifications on your device' })}
                        showChevron={false}
                        rightElement={
                            <Toggle value={prefs.pushEnabled} onValueChange={(v) => updatePreference('pushEnabled', v)} />
                        }
                    />
                    <SettingsItem
                        icon="mail"
                        title={t('settings.notifications.email', { defaultValue: 'Email notifications' })}
                        description={t('settings.notifications.emailDesc', { defaultValue: 'Receive email summaries of your notifications' })}
                        showChevron={false}
                        rightElement={
                            <Toggle value={prefs.emailEnabled} onValueChange={(v) => updatePreference('emailEnabled', v)} />
                        }
                    />
                </SettingsGroup>

                <SettingsGroup title={t('settings.notifications.sections.types', { defaultValue: 'Notification types' })}>
                    <SettingsItem
                        icon="heart"
                        title={t('settings.notifications.likes', { defaultValue: 'Likes' })}
                        description={t('settings.notifications.likesDesc', { defaultValue: 'When someone likes your post' })}
                        showChevron={false}
                        rightElement={
                            <Toggle value={prefs.likes} onValueChange={(v) => updatePreference('likes', v)} />
                        }
                    />
                    <SettingsItem
                        icon="repeat"
                        title={t('settings.notifications.reposts', { defaultValue: 'Reposts' })}
                        description={t('settings.notifications.repostsDesc', { defaultValue: 'When someone reposts your post' })}
                        showChevron={false}
                        rightElement={
                            <Toggle value={prefs.reposts} onValueChange={(v) => updatePreference('reposts', v)} />
                        }
                    />
                    <SettingsItem
                        icon="person-add"
                        title={t('settings.notifications.follows', { defaultValue: 'New followers' })}
                        description={t('settings.notifications.followsDesc', { defaultValue: 'When someone follows you' })}
                        showChevron={false}
                        rightElement={
                            <Toggle value={prefs.follows} onValueChange={(v) => updatePreference('follows', v)} />
                        }
                    />
                    <SettingsItem
                        icon="at"
                        title={t('settings.notifications.mentions', { defaultValue: 'Mentions' })}
                        description={t('settings.notifications.mentionsDesc', { defaultValue: 'When someone mentions you in a post' })}
                        showChevron={false}
                        rightElement={
                            <Toggle value={prefs.mentions} onValueChange={(v) => updatePreference('mentions', v)} />
                        }
                    />
                    <SettingsItem
                        icon="chatbubble"
                        title={t('settings.notifications.replies', { defaultValue: 'Replies' })}
                        description={t('settings.notifications.repliesDesc', { defaultValue: 'When someone replies to your post' })}
                        showChevron={false}
                        rightElement={
                            <Toggle value={prefs.replies} onValueChange={(v) => updatePreference('replies', v)} />
                        }
                    />
                    <SettingsItem
                        icon="chatbox-ellipses"
                        title={t('settings.notifications.quotes', { defaultValue: 'Quote posts' })}
                        description={t('settings.notifications.quotesDesc', { defaultValue: 'When someone quotes your post' })}
                        showChevron={false}
                        rightElement={
                            <Toggle value={prefs.quotes} onValueChange={(v) => updatePreference('quotes', v)} />
                        }
                    />
                </SettingsGroup>
            </ScrollView>
        </ThemedView>
    );
}
