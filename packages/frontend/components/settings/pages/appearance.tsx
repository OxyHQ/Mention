import { SettingsSelect } from "@/components/settings/SettingsSelect";
import { useThemeControls } from "@/hooks/useAccountTheme";
import {
  useAppearanceStore,
  type PostReadMoreAction,
  type PostTextExpand,
} from "@/stores/appearanceStore";
import { Loading } from "@oxy.so/bloom/loading";
import { SettingsGeneralPage } from "@oxy.so/bloom/settings-modal";
import { Switch } from "@oxy.so/bloom/switch";
import { useBloomTheme } from "@oxy.so/bloom/theme";
import { toast } from "@oxy.so/bloom/toast";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";

type ThemeMode = "system" | "light" | "dark";

export default function AppearanceSettingsScreen() {
  const mySettings = useAppearanceStore((state) => state.mySettings);
  const updateMySettings = useAppearanceStore(
    (state) => state.updateMySettings,
  );
  const { mode: bloomMode } = useBloomTheme();
  const { source, changeThemeSource, changeThemeMode } = useThemeControls();
  const { t } = useTranslation();

  const themeMode: ThemeMode =
    bloomMode === "adaptive" || bloomMode === "system" ? "system" : bloomMode;
  const postTextExpand: PostTextExpand =
    mySettings?.appearance?.postTextExpand ?? "default";
  const postReadMoreAction: PostReadMoreAction =
    mySettings?.appearance?.postReadMoreAction ?? "openPost";
  const collapseLongBio: boolean =
    mySettings?.appearance?.collapseLongBio ?? true;
  const [settingsSaving, setSettingsSaving] = useState(false);

  const saveSettings = useCallback(
    async (updates: {
      postTextExpand?: PostTextExpand;
      postReadMoreAction?: PostReadMoreAction;
      collapseLongBio?: boolean;
    }) => {
      setSettingsSaving(true);
      const expand = updates.postTextExpand ?? postTextExpand;
      const readMoreAction = updates.postReadMoreAction ?? postReadMoreAction;
      const collapseBio = updates.collapseLongBio ?? collapseLongBio;
      try {
        const result = await updateMySettings({
          appearance: {
            postTextExpand: expand,
            postReadMoreAction: readMoreAction,
            collapseLongBio: collapseBio,
          },
        });
        if (!result)
          toast.error(
            t("settings.saveFailed", {
              defaultValue: "Could not save settings. Please try again.",
            }),
          );
      } catch (error) {
        toast.error(
          error instanceof Error
            ? error.message
            : t("settings.saveFailed", {
                defaultValue: "Could not save settings. Please try again.",
              }),
        );
      } finally {
        setSettingsSaving(false);
      }
    },
    [t, postTextExpand, postReadMoreAction, collapseLongBio, updateMySettings],
  );

  // Color mode is owned by the theme bridge: it updates Bloom immediately and,
  // when the theme source is `account`, writes back to the Oxy account theme.
  const onThemeModeChange = useCallback(
    (mode: ThemeMode) => {
      setSettingsSaving(true);
      void changeThemeMode(mode)
        .catch((error) =>
          toast.error(
            error instanceof Error
              ? error.message
              : t("settings.saveFailed", {
                  defaultValue: "Could not save settings.",
                }),
          ),
        )
        .finally(() => setSettingsSaving(false));
    },
    [changeThemeMode, t],
  );

  const onPostTextExpandChange = useCallback(
    (value: PostTextExpand) => {
      void saveSettings({ postTextExpand: value });
    },
    [saveSettings],
  );

  const onPostReadMoreActionChange = useCallback(
    (value: PostReadMoreAction) => {
      void saveSettings({ postReadMoreAction: value });
    },
    [saveSettings],
  );

  const onCollapseLongBioChange = useCallback(
    (value: "collapse" | "full") => {
      void saveSettings({ collapseLongBio: value === "collapse" });
    },
    [saveSettings],
  );

  return (
    <SettingsGeneralPage
      sections={[
        {
          key: "theme",
          label: t("settings.theme", "Color mode"),
          rows: [
            {
              key: "sync",
              label: t(
                "settings.theme.source.useAccount",
                "Sync theme with account",
              ),
              description: t(
                "settings.theme.source.useAccountDesc",
                "Use your Oxy account theme on this device",
              ),
              control: (
                <Switch
                  checked={source === "account"}
                  onCheckedChange={(on) =>
                    changeThemeSource(on ? "account" : "app")
                  }
                  accessibilityLabel={t(
                    "settings.theme.source.useAccount",
                    "Sync theme with account",
                  )}
                />
              ),
            },
            {
              key: "mode",
              label: t("settings.theme", "Color mode"),
              control: (
                <SettingsSelect
                  label={t("settings.theme", "Color mode")}
                  value={themeMode}
                  onChange={onThemeModeChange}
                  items={[
                    {
                      value: "system",
                      label: t("settings.theme.system", "System"),
                    },
                    {
                      value: "light",
                      label: t("settings.theme.light", "Light"),
                    },
                    { value: "dark", label: t("settings.theme.dark", "Dark") },
                  ]}
                />
              ),
            },
          ],
        },
        {
          key: "reading",
          label: t("settings.appearance", "Appearance"),
          action: settingsSaving ? <Loading size="small" /> : undefined,
          rows: [
            {
              key: "length",
              label: t(
                "settings.appearance.postTextLength",
                "Post text length",
              ),
              control: (
                <SettingsSelect
                  label={t(
                    "settings.appearance.postTextLength",
                    "Post text length",
                  )}
                  value={postTextExpand}
                  onChange={onPostTextExpandChange}
                  items={[
                    {
                      value: "default",
                      label: t(
                        "settings.appearance.postTextLength.default",
                        "Default",
                      ),
                    },
                    {
                      value: "more",
                      label: t(
                        "settings.appearance.postTextLength.more",
                        "More",
                      ),
                    },
                    {
                      value: "muchMore",
                      label: t(
                        "settings.appearance.postTextLength.muchMore",
                        "Much more",
                      ),
                    },
                    {
                      value: "all",
                      label: t(
                        "settings.appearance.postTextLength.all",
                        "Show all",
                      ),
                    },
                  ]}
                />
              ),
            },
            {
              key: "read-more",
              label: t(
                "settings.appearance.readMoreAction",
                'On "Read more" tap',
              ),
              control: (
                <SettingsSelect
                  label={t(
                    "settings.appearance.readMoreAction",
                    'On "Read more" tap',
                  )}
                  value={postReadMoreAction}
                  onChange={onPostReadMoreActionChange}
                  items={[
                    {
                      value: "openPost",
                      label: t(
                        "settings.appearance.readMoreAction.openPost",
                        "Open post",
                      ),
                    },
                    {
                      value: "expandInline",
                      label: t(
                        "settings.appearance.readMoreAction.expandInline",
                        "Expand here",
                      ),
                    },
                  ]}
                />
              ),
            },
            {
              key: "bio",
              label: t("settings.appearance.collapseBio", "Profile bios"),
              control: (
                <SettingsSelect
                  label={t("settings.appearance.collapseBio", "Profile bios")}
                  value={collapseLongBio ? "collapse" : "full"}
                  onChange={onCollapseLongBioChange}
                  items={[
                    {
                      value: "collapse",
                      label: t(
                        "settings.appearance.collapseBio.collapse",
                        "Collapse if long",
                      ),
                    },
                    {
                      value: "full",
                      label: t(
                        "settings.appearance.collapseBio.full",
                        "Always show full",
                      ),
                    },
                  ]}
                />
              ),
            },
          ],
        },
      ]}
    />
  );
}
