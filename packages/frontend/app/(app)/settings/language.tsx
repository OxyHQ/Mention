import React, { useEffect, useState, useCallback } from 'react';
import { View, Text, ScrollView, TouchableOpacity } from 'react-native';
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
import { cn } from '@/lib/utils';

const IconComponent = Ionicons as any;

const LANGUAGE_OPTIONS = [
    { code: 'en-US', name: 'English', nativeName: 'English', flag: '\u{1F1FA}\u{1F1F8}' },
    { code: 'es-ES', name: 'Spanish', nativeName: 'Espa\u00F1ol', flag: '\u{1F1EA}\u{1F1F8}' },
    { code: 'it-IT', name: 'Italian', nativeName: 'Italiano', flag: '\u{1F1EE}\u{1F1F9}' },
];

const LANGUAGE_STORAGE_KEY = 'user_language_preference';

export default function LanguageSettingsScreen() {
    const { t } = useTranslation();
    const { colors } = useTheme();
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
        <ThemedView className="flex-1">
            <Header
                options={{
                    title: t('Language'),
                    leftComponents: [
                        <IconButton variant="icon"
                            key="back"
                            onPress={() => router.back()}
                        >
                            <BackArrowIcon size={20} className="text-foreground" />
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
                {saving && (
                    <View className="flex-row items-center justify-center py-3 mb-4 gap-2">
                        <Loading variant="inline" size="small" style={{ flex: undefined }} />
                        <Text className="text-sm text-muted-foreground">
                            {t('common.saving')}
                        </Text>
                    </View>
                )}

                <View className="mt-2">
                    <Text className="text-[13px] font-semibold uppercase tracking-wide mb-3 px-1 text-foreground">
                        {t('settings.language.selectLanguage')}
                    </Text>

                    <View className="rounded-2xl border border-border bg-card overflow-hidden">
                        {LANGUAGE_OPTIONS.map((option, index) => {
                            const isSelected = currentLanguage === option.code;
                            const isChanging = saving && isSelected;

                            return (
                                <View key={option.code}>
                                    <TouchableOpacity
                                        className={cn(
                                            "px-4 py-[18px]",
                                            index === 0 && "pt-[18px]",
                                            index === LANGUAGE_OPTIONS.length - 1 && "pb-[18px]"
                                        )}
                                        onPress={() => !saving && handleLanguageChange(option.code)}
                                        disabled={saving}
                                        activeOpacity={0.7}
                                    >
                                        <View className="flex-row items-center justify-between">
                                            <Text className="text-base font-medium flex-1 text-foreground">
                                                {getLanguageDisplayName(option)}
                                            </Text>
                                            {isSelected && (
                                                <View className="ml-3">
                                                    {isChanging ? (
                                                        <Loading variant="inline" size="small" style={{ flex: undefined }} />
                                                    ) : (
                                                        <IconComponent name="checkmark-circle" size={24} color={colors.primary} />
                                                    )}
                                                </View>
                                            )}
                                        </View>
                                    </TouchableOpacity>
                                    {index < LANGUAGE_OPTIONS.length - 1 && (
                                        <View className="h-px mx-4 bg-border" />
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
