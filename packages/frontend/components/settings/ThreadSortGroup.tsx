import React from 'react';
import { useTranslation } from 'react-i18next';
import { RiArrowDownLine, RiLineChartLine, RiTimeLine } from '@oxy.so/bloom/icons';
import { RadioIndicator } from '@oxy.so/bloom/radio-indicator';
import {
  SettingsListGroup,
  SettingsListItem,
  type SettingsListGroupVariant,
} from '@oxy.so/bloom/settings-list';
import { RowIcon, type BloomIcon } from '@/components/settings/RowIcon';
import { SORT_OPTIONS, useThreadPreferencesStore, type SortOrder } from '@/hooks/useThreadPreferences';

const SORT_ICONS: Record<SortOrder, BloomIcon> = {
  top: RiLineChartLine,
  oldest: RiTimeLine,
  newest: RiArrowDownLine,
};

/** The reply sort-order choice, wherever it is offered (settings screen, reply sheet). */
export function ThreadSortGroup({
  title,
  variant,
}: {
  title: string;
  variant?: SettingsListGroupVariant;
}) {
  const { t } = useTranslation();
  const sortOrder = useThreadPreferencesStore((state) => state.sortOrder);
  const setSortOrder = useThreadPreferencesStore((state) => state.setSortOrder);

  return (
    <SettingsListGroup title={title} variant={variant}>
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
