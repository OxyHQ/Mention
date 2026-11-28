import { useMemo } from 'react';
import { SuggestionList, type ChatComposerSuggestion } from '@oxy.so/bloom/chat-composer';
import { useTranslation } from 'react-i18next';
import type { SearchHashtagResult } from '@/services/searchService';

/** The `#` picker: Bloom's `SuggestionList`, with how many posts use each tag. */
export function HashtagPicker({
  hashtags,
  activeIndex,
  onActiveIndexChange,
  onSelect,
}: {
  hashtags: readonly SearchHashtagResult[];
  /** The highlighted row. The input owns it: its arrow keys move it. */
  activeIndex: number;
  onActiveIndexChange: (index: number) => void;
  onSelect: (tag: string) => void;
}) {
  const { t } = useTranslation();
  const suggestions = useMemo<ChatComposerSuggestion[]>(
    () =>
      hashtags.map(({ tag, count }) => ({
        id: tag,
        label: `#${tag}`,
        description: t('compose.hashtagPosts', { count }),
      })),
    [hashtags, t],
  );

  return (
    <SuggestionList
      kind="command"
      accessibilityLabel={t('compose.hashtagSuggestions')}
      suggestions={suggestions}
      activeIndex={activeIndex}
      onActiveIndexChange={onActiveIndexChange}
      onSelectSuggestion={(suggestion) => onSelect(suggestion.id)}
    />
  );
}
