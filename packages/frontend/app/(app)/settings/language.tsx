import React, { useCallback } from 'react';
import { PageHeader } from '@oxy.so/bloom/page-header';
import { ScrollView } from 'react-native';
import { ThemedView } from '@/components/ThemedView';
import { useSafeBack } from '@/hooks/useSafeBack';
import { useTranslation } from 'react-i18next';
import { useAuth, useOxy } from '@oxy.so/services/ui/client';
import { getNativeLanguageName } from '@oxy.so/core';
import { SettingsListGroup, SettingsListItem } from '@oxy.so/bloom/settings-list';
import { RowIcon } from '@/components/settings/RowIcon';
import { RiGlobalLine } from '@oxy.so/bloom/icons';
import { Toggle } from '@/components/Toggle';
import { useAutoTranslateStore } from '@/stores/autoTranslateStore';

/**
 * The app's UI language is an Oxy-account concern, not a Mention one: Oxy
 * already resolves it (account locales when signed in, a device/guest locale
 * otherwise) and ships the picker that reads and writes it
 * (`LanguageSelectorScreen`, opened here the same way every other Oxy-owned
 * surface is — `showBottomSheet('LanguageSelector')`, exactly like
 * `ManageAccount` elsewhere in Settings). This screen keeps only what is
 * genuinely Mention's: whether a post gets auto-translated on read.
 */
export default function LanguageSettingsScreen() {
    const { t } = useTranslation();
    const safeBack = useSafeBack();
    const { showBottomSheet } = useAuth();
    const { currentLanguage, currentLanguages } = useOxy();
    const autoTranslateEnabled = useAutoTranslateStore((s) => s.enabled);
    const setAutoTranslateEnabled = useAutoTranslateStore((s) => s.setEnabled);

    const openLanguageSelector = useCallback(() => {
        showBottomSheet?.('LanguageSelector');
    }, [showBottomSheet]);

    // Account locales when there are any (signed in, or a guest override was
    // set), else the single resolved device/fallback locale — the same
    // fallback `LanguageSelectorScreen` itself uses.
    const selectedLanguages = currentLanguages.length > 0 ? currentLanguages : [currentLanguage];
    const languageDescription = selectedLanguages.map((code) => getNativeLanguageName(code)).join(', ');

    return (
        <ThemedView className="flex-1">
            <PageHeader title={t('Language')} onBack={() => safeBack()} backLabel={t('common.back', { defaultValue: 'Back' })} border="none" sticky={false} />

            <ScrollView
                className="flex-1"
                contentContainerClassName="px-screen-margin py-2"
                showsVerticalScrollIndicator={false}
            >
                <SettingsListGroup title={t('settings.language.selectLanguage')}>
                    <SettingsListItem
                        icon={<RowIcon icon={RiGlobalLine} />}
                        title={t('Language')}
                        description={languageDescription}
                        onPress={openLanguageSelector}
                    />
                </SettingsListGroup>

                <SettingsListGroup title={t('settings.language.autoTranslate')}>
                    <SettingsListItem
                        icon={<RowIcon icon={RiGlobalLine} />}
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
