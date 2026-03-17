import React, { useEffect, useState, useCallback } from 'react';
import { View, Text, Pressable, ScrollView } from 'react-native';
import { Loading } from '@/components/ui/Loading';
import { ThemedView } from '@/components/ThemedView';
import { Header } from '@/components/Header';
import { IconButton } from '@/components/ui/Button';
import { BackArrowIcon } from '@/assets/icons/back-arrow-icon';
import { useTheme } from '@/hooks/useTheme';
import { useSafeBack } from '@/hooks/useSafeBack';
import { useTranslation } from 'react-i18next';
import i18n from 'i18next';
import { storeData, getData } from '@/utils/storage';
import { SettingsGroup } from '@/components/settings/SettingsItem';
import { Icon } from '@/lib/icons';

const LANGUAGE_OPTIONS = [
    { code: 'en-US', name: 'English', nativeName: 'English', flag: '\u{1F1FA}\u{1F1F8}' },
    { code: 'es-ES', name: 'Spanish', nativeName: 'Espa\u00F1ol', flag: '\u{1F1EA}\u{1F1F8}' },
    { code: 'it-IT', name: 'Italian', nativeName: 'Italiano', flag: '\u{1F1EE}\u{1F1F9}' },
];

const LANGUAGE_STORAGE_KEY = 'user_language_preference';

export default function LanguageSettingsScreen() {
    const { t } = useTranslation();
    const safeBack = useSafeBack();
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
            await storeData(LANGUAGE_STORAGE_KEY, languageCode);
            await i18n.changeLanguage(languageCode);
        } catch (error) {
            console.error('Error changing language:', error);
            setCurrentLanguage(i18n.language || 'en-US');
        } finally {
            setSaving(false);
        }
    }, [currentLanguage]);

    return (
        <ThemedView className="flex-1">
            <Header
                options={{
                    title: t('Language'),
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
                <SettingsGroup title={t('settings.language.selectLanguage')}>
                    {LANGUAGE_OPTIONS.map((option) => {
                        const isSelected = currentLanguage === option.code;

                        return (
                            <Pressable
                                key={option.code}
                                className="px-5 py-3 flex-row items-center justify-between"
                                style={{ minHeight: 48 }}
                                onPress={() => !saving && handleLanguageChange(option.code)}
                                disabled={saving}
                            >
                                <Text className="text-[16px] flex-1 text-foreground">
                                    {option.flag} {option.nativeName} ({option.name})
                                </Text>
                                {isSelected && (
                                    <Icon name="checkmark-circle" size={22} color={colors.primary} />
                                )}
                            </Pressable>
                        );
                    })}
                </SettingsGroup>
            </ScrollView>
        </ThemedView>
    );
}
