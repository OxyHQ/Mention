import { useHapticsStore } from "@/stores/hapticsStore";
import { SettingsGeneralPage } from "@oxy.so/bloom/settings-modal";
import { Switch } from "@oxy.so/bloom/switch";
import { useTranslation } from "react-i18next";
import { Platform } from "react-native";

export default function AccessibilitySettingsContent() {
  const { t } = useTranslation();
  const disabled = useHapticsStore((state) => state.disabled);
  const setDisabled = useHapticsStore((state) => state.setDisabled);
  const label = t("settings.accessibility.hapticFeedback", {
    defaultValue: "Haptic feedback",
  });
  return (
    <SettingsGeneralPage
      sections={[
        {
          key: "interaction",
          label: t("settings.accessibility.interaction", {
            defaultValue: "Interaction",
          }),
          rows: [
            {
              key: "haptics",
              label,
              description:
                Platform.OS === "web"
                  ? t("settings.accessibility.nativeHaptics", {
                      defaultValue: "Available in the mobile app.",
                    })
                  : t("settings.accessibility.hapticFeedbackDesc", {
                      defaultValue: "Vibration feedback on interactions",
                    }),
              control: (
                <Switch
                  checked={!disabled}
                  onCheckedChange={(enabled) => setDisabled(!enabled)}
                  disabled={Platform.OS === "web"}
                  accessibilityLabel={label}
                />
              ),
            },
          ],
        },
      ]}
    />
  );
}
