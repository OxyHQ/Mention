import { type BloomIcon } from "@/components/settings/RowIcon";
import { ThreadSortGroup } from "@/components/settings/ThreadSortGroup";
import {
  useThreadPreferencesStore,
  type VoteStyle,
} from "@/hooks/useThreadPreferences";
import { Button } from "@oxy.so/bloom/button";
import { RiArrowUpSLine } from '@oxy.so/bloom/icons/RiArrowUpSLine';
import { RiHeartLine } from '@oxy.so/bloom/icons/RiHeartLine';
import { RadioIndicator } from "@oxy.so/bloom/radio-indicator";
import {
  SettingsCard,
  SettingsRow,
  SettingsSection,
} from "@oxy.so/bloom/settings-modal";
import { Switch } from "@oxy.so/bloom/switch";
import { useTranslation } from "react-i18next";
import { View } from "react-native";

const VOTE_STYLE_OPTIONS: {
  value: VoteStyle;
  icon: BloomIcon;
  labelKey: string;
  defaultLabel: string;
}[] = [
  {
    value: "heart",
    icon: RiHeartLine,
    labelKey: "settings.threadPreferences.voteStyleHeart",
    defaultLabel: "Heart",
  },
  {
    value: "pill",
    icon: RiArrowUpSLine,
    labelKey: "settings.threadPreferences.voteStylePill",
    defaultLabel: "Up/down vote",
  },
];

export default function ThreadPreferencesScreen() {
  const { t } = useTranslation();

  // All three preferences live in the one store, which owns persistence — so
  // every row reads and writes the same value, with no local copy to sync.
  const { treeView, voteStyle, setTreeView, setVoteStyle } =
    useThreadPreferencesStore();

  return (
    <View className="gap-4">
      <View className="gap-4">
        <ThreadSortGroup
          title={t("settings.threadPreferences.sortReplies", {
            defaultValue: "Sort replies",
          })}
        />

        <SettingsSection
          label={t("settings.threadPreferences.likeStyle", {
            defaultValue: "Like style",
          })}
        >
          <SettingsCard>
            {VOTE_STYLE_OPTIONS.map((option) => (
              <SettingsRow
                label={t(option.labelKey, {
                  defaultValue: option.defaultLabel,
                })}
                key={option.value}
              >
                <Button
                  size="small"
                  appearance="subtle"
                  tone="neutral"
                  onPress={() => setVoteStyle(option.value)}
                  accessibilityLabel={t(option.labelKey, {
                    defaultValue: option.defaultLabel,
                  })}
                >
                  {<RadioIndicator selected={voteStyle === option.value} />}
                </Button>
              </SettingsRow>
            ))}
          </SettingsCard>
        </SettingsSection>

        <SettingsSection
          label={t("settings.threadPreferences.display", {
            defaultValue: "Display",
          })}
        >
          <SettingsCard>
            <SettingsRow
              label={t("settings.threadPreferences.treeView", {
                defaultValue: "Threaded tree view",
              })}
              description={t("settings.threadPreferences.treeViewDesc", {
                defaultValue: "Show replies in a threaded tree structure",
              })}
            >
              {
                <Switch
                  checked={treeView}
                  onCheckedChange={setTreeView}
                  accessibilityLabel={t("settings.threadPreferences.treeView", {
                    defaultValue: "Threaded tree view",
                  })}
                />
              }
            </SettingsRow>
          </SettingsCard>
        </SettingsSection>
      </View>
    </View>
  );
}
