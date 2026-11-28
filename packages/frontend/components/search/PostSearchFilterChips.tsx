import { View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Chip, ChipRow } from '@oxy.so/bloom/chip';
import type { PostSearchFilters } from '@/utils/postSearchFilters';

const OPTIONS: ReadonlyArray<{ id: keyof PostSearchFilters; labelKey: string }> = [
  { id: 'media', labelKey: 'search.filters.media' },
  { id: 'pastWeek', labelKey: 'search.filters.pastWeek' },
  { id: 'popular', labelKey: 'search.filters.popular' },
];

/** Toggles that narrow the Posts results. */
export function PostSearchFilterChips({
  filters,
  onChange,
}: {
  filters: PostSearchFilters;
  onChange: (filters: PostSearchFilters) => void;
}) {
  const { t } = useTranslation();
  return (
    <View className="py-2">
      <ChipRow contentInset={16} accessibilityLabel={t('search.filters.label')}>
        {OPTIONS.map(({ id, labelKey }) => (
          <Chip
            key={id}
            variant="subtle"
            selected={filters[id]}
            onPress={() => onChange({ ...filters, [id]: !filters[id] })}
          >
            {t(labelKey)}
          </Chip>
        ))}
      </ChipRow>
    </View>
  );
}
