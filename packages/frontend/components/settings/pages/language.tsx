import { useMentionSettings } from '@/context/MentionSettingsContext';
import { getNativeLanguageName } from '@oxy.so/core';
import { useAuth, useOxy } from '@oxy.so/services/ui/client';
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Button as LButton, Embed, Text, VStack, toElement } from '@oxy.so/bloom-language';
import {
  GroupedSection as LGroupedSection,
  GroupedSectionItem as LGroupedSectionItem,
} from '@oxy.so/bloom-language/containers';
import { SettingsSection as LSettingsSection } from '@oxy.so/bloom-language/settings';

/**
 * The app's UI language is an Oxy-account concern, not a Mention one: Oxy
 * already resolves it (account locales when signed in, a device/guest locale
 * otherwise) and ships the picker that reads and writes it
 * (`LanguageSelectorScreen`, opened here the same way every other Oxy-owned
 * surface is — `showBottomSheet('LanguageSelector')`, exactly like
 * `ManageAccount` elsewhere in Settings). There is no Mention-side language
 * preference: which rendition of a post a reader sees is the server's hydration
 * choice, and a translation only ever happens on an explicit reader action.
 */
export default function LanguageSettingsScreen() {
  const { t } = useTranslation();

  const { showBottomSheet } = useAuth();
  const { afterClose } = useMentionSettings();
  const { currentLanguage, currentLanguages } = useOxy();

  const openLanguageSelector = useCallback(() => {
    afterClose(() => showBottomSheet?.('LanguageSelector'));
  }, [showBottomSheet, afterClose]);

  // Account locales when there are any (signed in, or a guest override was
  // set), else the single resolved device/fallback locale — the same
  // fallback `LanguageSelectorScreen` itself uses.
  const selectedLanguages = currentLanguages.length > 0 ? currentLanguages : [currentLanguage];
  const languageDescription = selectedLanguages
    .map((code) => getNativeLanguageName(code))
    .join(', ');

  return toElement(
    VStack(
      VStack(
        LSettingsSection(
          t('settings.language.selectLanguage'),
          LGroupedSection(
            LGroupedSectionItem(t('settings.language.title'))
              .wrapControl()
              .description(languageDescription)
              .trailing(
                Embed(
                  <>
                    {toElement(
                      LButton(Text(t('common.open', { defaultValue: 'Open' })))
                        .size('sm')
                        .style('subtle')
                        .tint('neutral')
                        .onPress(openLanguageSelector)
                        .label(t('settings.language.title')),
                    )}
                  </>,
                ),
              ),
          ),
        ),
      ).spacing('lg'),
    ).spacing('lg'),
  );
}
