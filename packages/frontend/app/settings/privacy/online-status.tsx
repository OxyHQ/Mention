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

export default function OnlineStatusScreen() {
    const { t } = useTranslation();
    const theme = useTheme();

    const [showOnlineStatus, setShowOnlineStatus] = useState(true);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        loadSettings();
    }, []);

    const loadSettings = async () => {
        try {
            const response = await authenticatedClient.get('/profile/settings/me');
            const settings = response.data;
            setShowOnlineStatus(settings.privacy?.showOnlineStatus !== false);
            setLoading(false);
        } catch (error) {
            console.error('Error loading settings:', error);
            setLoading(false);
        }
    };

    const updateSetting = async (value: boolean) => {
        try {
            await authenticatedClient.put('/profile/settings', {
                privacy: {
                    showOnlineStatus: value
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
                        title: t('settings.privacy.onlineStatus'),
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
                    title: t('settings.privacy.onlineStatus'),
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
                    <View style={[styles.settingItem, styles.firstSettingItem, styles.lastSettingItem]}>
                        <View style={styles.settingInfo}>
                            <View>
                                <Text style={[styles.settingLabel, { color: theme.colors.text }]}>
                                    {t('settings.privacy.showOnlineStatus')}
                                </Text>
                                <Text style={[styles.settingDescription, { color: theme.colors.textSecondary }]}>
                                    {t('settings.privacy.showOnlineStatusDesc')}
                                </Text>
                            </View>
                        </View>
                        <Toggle
                            value={showOnlineStatus}
                            onValueChange={(value) => {
                                setShowOnlineStatus(value);
                                updateSetting(value);
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

