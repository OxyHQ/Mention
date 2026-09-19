import React from 'react';
import { useTranslation } from 'react-i18next';
import { RiArrowDownLine } from '@oxy.so/bloom/icons/RiArrowDownLine';
import { RiLineChartLine } from '@oxy.so/bloom/icons/RiLineChartLine';
import { RiTimeLine } from '@oxy.so/bloom/icons/RiTimeLine';
import { RadioIndicator } from '@oxy.so/bloom/radio-indicator';
import { SettingsListGroup, SettingsListItem } from '@oxy.so/bloom/settings-list';
import { RowIcon, type BloomIcon } from '@/components/settings/RowIcon';
import { SORT_OPTIONS, useThreadPreferencesStore, type SortOrder } from '@/hooks/useThreadPreferences';

const SORT_ICONS: Record<SortOrder, BloomIcon> = {
  top: RiLineChartLine,
  oldest: RiTimeLine,
  newest: RiArrowDownLine,
};

/**
 * The reply sort-order choice, wherever it is offered (settings screen, reply
 * sheet).
 *
 * No `variant`: the group reads the surface it landed on (Bloom 2.12). On the
 * thread-preferences screen that is the app's `ContentPanel`, in the reply
 * sheet it is the sheet's own fill — the two callers that used to have to
 * answer that question for it.
 */
export function ThreadSortGroup({ title }: { title: string }) {
  const { t } = useTranslation();
  const sortOrder = useThreadPreferencesStore((state) => state.sortOrder);
  const setSortOrder = useThreadPreferencesStore((state) => state.setSortOrder);

  return (
    <SettingsListGroup title={title}>
      {SORT_OPTIONS.map((option) => (
        <SettingsListItem
          key={option.value}
          icon={<RowIcon icon={SORT_ICONS[option.value]} />}
          title={t(option.labelKey, { defaultValue: option.defaultLabel })}
          rightElement={<RadioIndicator selected={sortOrder === option.value} />}
          showChevron={false}
          onPress={() => setSortOrder(option.value)}
        />
      ))}
    </SettingsListGroup>
  );
}
