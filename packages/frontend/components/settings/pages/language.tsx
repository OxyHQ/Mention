import { useMentionSettings } from "@/context/MentionSettingsContext";
import { Button } from "@oxy.so/bloom/button";
import {
  SettingsCard,
  SettingsRow,
  SettingsSection,
} from "@oxy.so/bloom/settings-modal";
import { getNativeLanguageName } from "@oxy.so/core";
import { useAuth, useOxy } from "@oxy.so/services/ui/client";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";

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
    afterClose(() => showBottomSheet?.("LanguageSelector"));
  }, [showBottomSheet, afterClose]);

  // Account locales when there are any (signed in, or a guest override was
  // set), else the single resolved device/fallback locale — the same
  // fallback `LanguageSelectorScreen` itself uses.
  const selectedLanguages =
    currentLanguages.length > 0 ? currentLanguages : [currentLanguage];
  const languageDescription = selectedLanguages
    .map((code) => getNativeLanguageName(code))
    .join(", ");

  return (
    <View className="gap-4">
      <View className="gap-4">
        <SettingsSection label={t("settings.language.selectLanguage")}>
          <SettingsCard>
            <SettingsRow
              label={t("Language")}
              description={languageDescription}
            >
              <Button
                size="small"
                appearance="subtle"
                tone="neutral"
                onPress={openLanguageSelector}
                accessibilityLabel={t("Language")}
              >
                {t("common.open", { defaultValue: "Open" })}
              </Button>
            </SettingsRow>
          </SettingsCard>
        </SettingsSection>
      </View>
    </View>
  );
}
