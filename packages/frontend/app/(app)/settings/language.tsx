import React, { useEffect, useState, useCallback } from 'react';
import { View, Text, Pressable, ScrollView } from 'react-native';
import { Loading } from '@oxyhq/bloom/loading';
import { ThemedView } from '@/components/ThemedView';
import { Header } from '@/components/Header';
import { IconButton } from '@/components/ui/Button';
import { BackArrowIcon } from '@/assets/icons/back-arrow-icon';
import { useTheme } from '@oxyhq/bloom/theme';
import { useSafeBack } from '@/hooks/useSafeBack';
import { useTranslation } from 'react-i18next';
import i18n from 'i18next';
import { setLanguage } from '@/lib/i18n';
import { Storage } from '@/utils/storage';
import { STORAGE_KEYS, SUPPORTED_LANGUAGES } from '@/lib/constants';
import { SettingsListGroup, SettingsListItem } from '@oxyhq/bloom/settings-list';
import { RowIcon } from '@/components/settings/RowIcon';
import { Toggle } from '@/components/Toggle';
import { Icon } from '@/lib/icons';
import { logger } from '@oxyhq/core/logger';
import { useAutoTranslateStore } from '@/stores/autoTranslateStore';

/**
 * Display metadata per supported locale.
 *
 * Keyed by `SUPPORTED_LANGUAGES` rather than listing the codes again, and typed
 * as an EXHAUSTIVE record so the compiler requires an entry for each one. This
 * screen used to carry its own copy of the code list — a third one, after
 * `SUPPORTED_LANGUAGES` and `lib/i18n`'s `TRANSLATION_LOADERS` — so adding a
 * locale to the two that matter left the settings screen silently unable to
 * offer it, with nothing failing.
 */
const LANGUAGE_DISPLAY: Record<
    (typeof SUPPORTED_LANGUAGES)[number],
    { name: string; nativeName: string; flag: string }
> = {
    'en-US': { name: 'English', nativeName: 'English', flag: '\u{1F1FA}\u{1F1F8}' },
    'es-ES': { name: 'Spanish', nativeName: 'Espa\u00F1ol', flag: '\u{1F1EA}\u{1F1F8}' },
    'it-IT': { name: 'Italian', nativeName: 'Italiano', flag: '\u{1F1EE}\u{1F1F9}' },
    'ca-ES': { name: 'Catalan', nativeName: 'Català', flag: '\u{1F1E6}\u{1F1E9}' },
    'fr-FR': { name: 'French', nativeName: 'Français', flag: '\u{1F1EB}\u{1F1F7}' },
    'pt-BR': { name: 'Portuguese', nativeName: 'Português', flag: '\u{1F1E7}\u{1F1F7}' },
    'de-DE': { name: 'German', nativeName: 'Deutsch', flag: '\u{1F1E9}\u{1F1EA}' },
    'ru-RU': { name: 'Russian', nativeName: 'Русский', flag: '\u{1F1F7}\u{1F1FA}' },
    'zh-CN': { name: 'Chinese', nativeName: '简体中文', flag: '\u{1F1E8}\u{1F1F3}' },
    'hi-IN': { name: 'Hindi', nativeName: 'हिन्दी', flag: '\u{1F1EE}\u{1F1F3}' },
    'ar-SA': { name: 'Arabic', nativeName: 'العربية', flag: '\u{1F1F8}\u{1F1E6}' },
    'bn-BD': { name: 'Bengali', nativeName: 'বাংলা', flag: '\u{1F1E7}\u{1F1E9}' },
    'ja-JP': { name: 'Japanese', nativeName: '日本語', flag: '\u{1F1EF}\u{1F1F5}' },
    'id-ID': { name: 'Indonesian', nativeName: 'Bahasa Indonesia', flag: '\u{1F1EE}\u{1F1E9}' },
    'tr-TR': { name: 'Turkish', nativeName: 'Türkçe', flag: '\u{1F1F9}\u{1F1F7}' },
};

const LANGUAGE_OPTIONS = SUPPORTED_LANGUAGES.map((code) => ({
    code,
    ...LANGUAGE_DISPLAY[code],
}));

export default function LanguageSettingsScreen() {
    const { t } = useTranslation();
    const safeBack = useSafeBack();
    const { colors } = useTheme();
    const [currentLanguage, setCurrentLanguage] = useState<string>('en-US');
    const [saving, setSaving] = useState(false);
    const autoTranslateEnabled = useAutoTranslateStore((s) => s.enabled);
    const setAutoTranslateEnabled = useAutoTranslateStore((s) => s.setEnabled);

    const loadLanguage = useCallback(async () => {
        try {
            const savedLanguage = await Storage.get<string>(STORAGE_KEYS.LANGUAGE_PREFERENCE);
            const language = savedLanguage || i18n.language || 'en-US';
            setCurrentLanguage(language);
        } catch (error) {
            logger.error('Error loading language', error);
            setCurrentLanguage(i18n.language || 'en-US');
        }
    }, []);

    useEffect(() => {
        void loadLanguage();
    }, [loadLanguage]);

    const handleLanguageChange = useCallback(async (languageCode: string) => {
        if (languageCode === currentLanguage) return;

        try {
            setSaving(true);
            setCurrentLanguage(languageCode);
            await Storage.set(STORAGE_KEYS.LANGUAGE_PREFERENCE, languageCode);
            await setLanguage(languageCode);
        } catch (error) {
            logger.error('Error changing language', error);
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
                            <Loading className="text-primary" variant="inline" size="small" />
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
                <SettingsListGroup title={t('settings.language.selectLanguage')}>
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
                </SettingsListGroup>

                <SettingsListGroup title={t('settings.language.autoTranslate')}>
                    <SettingsListItem
                        icon={<RowIcon name="language" />}
                        title={t('settings.language.autoTranslate')}
                        description={t('settings.language.autoTranslateDesc')}
                        rightElement={
                            <Toggle
                                value={autoTranslateEnabled}
                                onValueChange={setAutoTranslateEnabled}
                            />
                        }
                    />
                </SettingsListGroup>
            </ScrollView>
        </ThemedView>
    );
}
