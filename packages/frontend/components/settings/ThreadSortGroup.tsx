import {
SORT_OPTIONS,
useThreadPreferencesStore,
} from "@/hooks/useThreadPreferences";
import { SettingsCard,SettingsRow } from "@oxy.so/bloom/settings-modal";
import { useTranslation } from "react-i18next";
import { SettingsSelect } from "./SettingsSelect";

/** One reply-sorting model and Bloom row for both settings and reply preferences. */
export function ThreadSortGroup({ title }: { title: string }) {
  const { t } = useTranslation();
  const sortOrder = useThreadPreferencesStore((state) => state.sortOrder);
  const setSortOrder = useThreadPreferencesStore((state) => state.setSortOrder);
  return (
    <SettingsCard>
      <SettingsRow label={title}>
        <SettingsSelect
          label={title}
          value={sortOrder}
          onChange={setSortOrder}
          items={SORT_OPTIONS.map((option) => ({
            value: option.value,
            label: t(option.labelKey, { defaultValue: option.defaultLabel }),
          }))}
        />
      </SettingsRow>
    </SettingsCard>
  );
}
