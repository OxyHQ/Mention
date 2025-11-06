import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet, ScrollView, ActivityIndicator } from 'react-native';
import { ThemedView } from '@/components/ThemedView';
import { Header } from '@/components/Header';
import { HeaderIconButton } from '@/components/HeaderIconButton';
import { BackArrowIcon } from '@/assets/icons/back-arrow-icon';
import { router } from 'expo-router';
import { useTheme } from '@/hooks/useTheme';
import { useTranslation } from 'react-i18next';
import { authenticatedClient } from '@/utils/api';
import { Toggle } from '@/components/Toggle';

export default function TagsMentionsScreen() {
    const { t } = useTranslation();
    const theme = useTheme();

    const [allowTags, setAllowTags] = useState(true);
    const [allowMentions, setAllowMentions] = useState(true);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        loadSettings();
    }, []);

    const loadSettings = async () => {
        try {
            const response = await authenticatedClient.get('/profile/settings/me');
            const settings = response.data;
            setAllowTags(settings.privacy?.allowTags !== false);
            setAllowMentions(settings.privacy?.allowMentions !== false);
            setLoading(false);
        } catch (error) {
            console.error('Error loading settings:', error);
            setLoading(false);
        }
    };

    const updateSetting = async (field: 'allowTags' | 'allowMentions', value: boolean) => {
        try {
            await authenticatedClient.put('/profile/settings', {
                privacy: {
                    [field]: value
                }
            });
        } catch (error) {
            console.error('Error updating setting:', error);
        }
    };

    if (loading) {
        return (
            <ThemedView style={styles.container}>
                <Header
                    options={{
                        title: t('settings.privacy.tagsAndMentions'),
                        leftComponents: [
                            <HeaderIconButton
                                key="back"
                                onPress={() => router.back()}
                            >
                                <BackArrowIcon size={20} color={theme.colors.text} />
                            </HeaderIconButton>,
                        ],
                    }}
                    hideBottomBorder={true}
                    disableSticky={true}
                />
                <View style={styles.loadingContainer}>
                    <ActivityIndicator size="large" color={theme.colors.primary} />
                </View>
            </ThemedView>
        );
    }

    return (
        <ThemedView style={styles.container}>
            <Header
                options={{
                    title: t('settings.privacy.tagsAndMentions'),
                    leftComponents: [
                        <HeaderIconButton
                            key="back"
                            onPress={() => router.back()}
                        >
                            <BackArrowIcon size={20} color={theme.colors.text} />
                        </HeaderIconButton>,
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
                <View style={[styles.settingsCard, { backgroundColor: theme.colors.card, borderColor: theme.colors.border }]}>
                    <View style={[styles.settingItem, styles.firstSettingItem]}>
                        <View style={styles.settingInfo}>
                            <View>
                                <Text style={[styles.settingLabel, { color: theme.colors.text }]}>
                                    {t('settings.privacy.allowTags')}
                                </Text>
                                <Text style={[styles.settingDescription, { color: theme.colors.textSecondary }]}>
                                    {t('settings.privacy.allowTagsDesc')}
                                </Text>
                            </View>
                        </View>
                        <Toggle
                            value={allowTags}
                            onValueChange={(value) => {
                                setAllowTags(value);
                                updateSetting('allowTags', value);
                            }}
                        />
                    </View>

                    <View style={[styles.divider, { backgroundColor: theme.colors.border }]} />

                    <View style={[styles.settingItem, styles.lastSettingItem]}>
                        <View style={styles.settingInfo}>
                            <View>
                                <Text style={[styles.settingLabel, { color: theme.colors.text }]}>
                                    {t('settings.privacy.allowMentions')}
                                </Text>
                                <Text style={[styles.settingDescription, { color: theme.colors.textSecondary }]}>
                                    {t('settings.privacy.allowMentionsDesc')}
                                </Text>
                            </View>
                        </View>
                        <Toggle
                            value={allowMentions}
                            onValueChange={(value) => {
                                setAllowMentions(value);
                                updateSetting('allowMentions', value);
                            }}
                        />
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
    scrollView: {
        flex: 1,
    },
    content: {
        paddingHorizontal: 16,
        paddingTop: 20,
        paddingBottom: 24,
    },
    loadingContainer: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
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
        flex: 1,
    },
    settingLabel: {
        fontSize: 16,
        fontWeight: '500',
        marginBottom: 4,
    },
    settingDescription: {
        fontSize: 14,
        lineHeight: 20,
    },
});

