import React, { useEffect, useState, useCallback } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity } from 'react-native';
import { Loading } from '@/components/ui/Loading';
import { ThemedView } from '@/components/ThemedView';
import { Header } from '@/components/Header';
import { IconButton } from '@/components/ui/Button';
import { BackArrowIcon } from '@/assets/icons/back-arrow-icon';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@/hooks/useTheme';
import { useTranslation } from 'react-i18next';
import i18n from 'i18next';
import { storeData, getData } from '@/utils/storage';

const IconComponent = Ionicons as any;

const LANGUAGE_OPTIONS = [
    { code: 'en-US', name: 'English', nativeName: 'English', flag: '🇺🇸' },
    { code: 'es-ES', name: 'Spanish', nativeName: 'Español', flag: '🇪🇸' },
    { code: 'it-IT', name: 'Italian', nativeName: 'Italiano', flag: '🇮🇹' },
];

const LANGUAGE_STORAGE_KEY = 'user_language_preference';

export default function LanguageSettingsScreen() {
    const { t } = useTranslation();
    const theme = useTheme();
    const [currentLanguage, setCurrentLanguage] = useState<string>('en-US');
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        loadLanguage();
    }, []);

    const loadLanguage = useCallback(async () => {
        try {
            const savedLanguage = await getData<string>(LANGUAGE_STORAGE_KEY);
            const language = savedLanguage || i18n.language || 'en-US';
            setCurrentLanguage(language);
        } catch (error) {
            console.error('Error loading language:', error);
            setCurrentLanguage(i18n.language || 'en-US');
        }
    }, []);

    const handleLanguageChange = useCallback(async (languageCode: string) => {
        if (languageCode === currentLanguage) return;

        try {
            setSaving(true);
            setCurrentLanguage(languageCode);
            
            // Save to storage
            await storeData(LANGUAGE_STORAGE_KEY, languageCode);
            
            // Change i18n language
            await i18n.changeLanguage(languageCode);
            
            // Small delay to show feedback
            await new Promise(resolve => setTimeout(resolve, 300));
        } catch (error) {
            console.error('Error changing language:', error);
            // Revert on error
            setCurrentLanguage(i18n.language || 'en-US');
        } finally {
            setSaving(false);
        }
    }, [currentLanguage]);

    const getLanguageDisplayName = (option: typeof LANGUAGE_OPTIONS[0]) => {
        return `${option.flag} ${option.nativeName} (${option.name})`;
    };

    return (
        <ThemedView style={styles.container}>
            <Header
                options={{
                    title: t('Language'),
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
                {saving && (
                    <View style={styles.savingIndicator}>
                        <Loading variant="inline" size="small" style={{ flex: undefined }} />
                        <Text style={[styles.savingText, { color: theme.colors.textSecondary }]}>
                            {t('common.saving')}
                        </Text>
                    </View>
                )}

                <View style={styles.section}>
                    <Text style={[styles.sectionTitle, { color: theme.colors.text }]}>
                        {t('settings.language.selectLanguage')}
                    </Text>

                    <View style={[styles.settingsCard, { backgroundColor: theme.colors.card, borderColor: theme.colors.border }]}>
                        {LANGUAGE_OPTIONS.map((option, index) => {
                            const isSelected = currentLanguage === option.code;
                            const isChanging = saving && isSelected;

                            return (
                                <View key={option.code}>
                                    <TouchableOpacity
                                        style={[
                                            styles.optionItem,
                                            index === 0 && styles.firstOptionItem,
                                            index === LANGUAGE_OPTIONS.length - 1 && styles.lastOptionItem,
                                        ]}
                                        onPress={() => !saving && handleLanguageChange(option.code)}
                                        disabled={saving}
                                        activeOpacity={0.7}
                                    >
                                        <View style={styles.optionContent}>
                                            <Text style={[styles.optionText, { color: theme.colors.text }]}>
                                                {getLanguageDisplayName(option)}
                                            </Text>
                                            {isSelected && (
                                                <View style={styles.selectedIndicator}>
                                                    {isChanging ? (
                                                        <Loading variant="inline" size="small" style={{ flex: undefined }} />
                                                    ) : (
                                                        <IconComponent name="checkmark-circle" size={24} color={theme.colors.primary} />
                                                    )}
                                                </View>
                                            )}
                                        </View>
                                    </TouchableOpacity>
                                    {index < LANGUAGE_OPTIONS.length - 1 && (
                                        <View style={[styles.divider, { backgroundColor: theme.colors.border }]} />
                                    )}
                                </View>
                            );
                        })}
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
    savingIndicator: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        paddingVertical: 12,
        marginBottom: 16,
        gap: 8,
    },
    savingText: {
        fontSize: 14,
    },
    section: {
        marginTop: 8,
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
    optionItem: {
        paddingHorizontal: 16,
        paddingVertical: 18,
    },
    firstOptionItem: {
        paddingTop: 18,
    },
    lastOptionItem: {
        paddingBottom: 18,
    },
    optionContent: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
    },
    optionText: {
        fontSize: 16,
        fontWeight: '500',
        flex: 1,
    },
    selectedIndicator: {
        marginLeft: 12,
    },
    divider: {
        height: 1,
        marginHorizontal: 16,
    },
});

