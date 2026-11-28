import { GroupedSection, GroupedSectionItem } from '@oxy.so/bloom/grouped-section';
import { SORT_OPTIONS, useThreadPreferencesStore } from '@/hooks/useThreadPreferences';

import { useTranslation } from 'react-i18next';
import { SettingsSelect } from '@oxy.so/bloom/settings-modal/select';

/** One reply-sorting model and Bloom row for both settings and reply preferences. */
export function ThreadSortGroup({ title }: { title: string }) {
  const { t } = useTranslation();
  const sortOrder = useThreadPreferencesStore((state) => state.sortOrder);
  const setSortOrder = useThreadPreferencesStore((state) => state.setSortOrder);
  return (
    <GroupedSection>
      <GroupedSectionItem
        wrapControl
        title={title}
        rightElement={
          <>
            <SettingsSelect
              label={title}
              value={sortOrder}
              onChange={setSortOrder}
              items={SORT_OPTIONS.map((option) => ({
                value: option.value,
                label: t(option.labelKey, { defaultValue: option.defaultLabel }),
              }))}
            />
          </>
        }
      />
    </GroupedSection>
  );
}
