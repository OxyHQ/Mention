import { SORT_OPTIONS, useThreadPreferencesStore } from '@/hooks/useThreadPreferences';

import { useTranslation } from 'react-i18next';
import { Embed, toElement } from '@oxy.so/bloom-language';
import {
  GroupedSection as LGroupedSection,
  GroupedSectionItem as LGroupedSectionItem,
} from '@oxy.so/bloom-language/containers';
import { SettingsSelect as LSettingsSelect } from '@oxy.so/bloom-language/settings';

/** One reply-sorting model and Bloom row for both settings and reply preferences. */
export function ThreadSortGroup({ title }: { title: string }) {
  const { t } = useTranslation();
  const sortOrder = useThreadPreferencesStore((state) => state.sortOrder);
  const setSortOrder = useThreadPreferencesStore((state) => state.setSortOrder);
  return toElement(
    LGroupedSection(
      LGroupedSectionItem(title)
        .wrapControl()
        .trailing(
          Embed(
            <>
              {toElement(
                LSettingsSelect(
                  title,
                  [sortOrder, setSortOrder],
                  SORT_OPTIONS.map((option) => ({
                    value: option.value,
                    label: t(option.labelKey, { defaultValue: option.defaultLabel }),
                  })),
                ),
              )}
            </>,
          ),
        ),
    ),
  );
}
