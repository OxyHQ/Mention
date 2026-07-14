import React, { memo, useCallback, useMemo, useState } from 'react';
import { FlatList, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Item } from '@oxyhq/bloom/item';
import { useTheme } from '@oxyhq/bloom/theme';
import { CloseIcon } from '@/assets/icons/close-icon';
import { IconButton } from '@/components/ui/Button';
import { CONTENT_LANGUAGES, type ContentLanguage } from '@/constants/contentLanguages';

interface LanguagePickerSheetProps {
  /**
   * Languages already on this post. They are listed as disabled rather than
   * hidden — an author looking for Spanish should see that Spanish is already
   * there, not that it vanished.
   */
  usedTags: readonly string[];
  /** The tag being replaced, when the sheet was opened from an existing tab. */
  currentTag?: string;
  /** Offered only when an existing NON-PRIMARY tab is being edited. */
  onRemove?: () => void;
  onSelect: (tag: string) => void;
  onClose: () => void;
}

const keyExtractor = (language: ContentLanguage) => language.tag;

/**
 * Picks the language of a compose tab: the post's primary language, or one of
 * its additional author renditions.
 */
const LanguagePickerSheet = memo(function LanguagePickerSheet({
  usedTags,
  currentTag,
  onRemove,
  onSelect,
  onClose,
}: LanguagePickerSheetProps) {
  const { t } = useTranslation();
  const theme = useTheme();
  const [query, setQuery] = useState('');

  const results = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle.length === 0) return CONTENT_LANGUAGES;
    return CONTENT_LANGUAGES.filter(
      (language) =>
        language.nativeName.toLowerCase().includes(needle) ||
        language.englishName.toLowerCase().includes(needle) ||
        language.tag.toLowerCase().includes(needle),
    );
  }, [query]);

  const handleSelect = useCallback(
    (tag: string) => {
      onSelect(tag);
      onClose();
    },
    [onSelect, onClose],
  );

  const handleRemove = useCallback(() => {
    onRemove?.();
    onClose();
  }, [onRemove, onClose]);

  const renderItem = useCallback(
    ({ item }: { item: ContentLanguage }) => {
      const isCurrent = item.tag === currentTag;
      const isTaken = !isCurrent && usedTags.includes(item.tag);
      return (
        <Item
          onPress={isTaken ? undefined : () => handleSelect(item.tag)}
          disabled={isTaken}
          title={item.nativeName}
          subtitle={
            isTaken
              ? t('compose.languages.alreadyAdded', { defaultValue: 'Already added' })
              : item.englishName
          }
          trailing={
            isCurrent ? (
              <Text className="text-primary text-[13px] font-semibold">
                {t('compose.languages.current', { defaultValue: 'Current' })}
              </Text>
            ) : undefined
          }
        />
      );
    },
    [currentTag, handleSelect, t, usedTags],
  );

  return (
    <View className="flex-1 pb-6 bg-background">
      <View className="flex-row items-center px-4 py-2 min-h-[48px] border-b border-border">
        <IconButton variant="icon" onPress={onClose} className="mr-1.5 z-[1]">
          <CloseIcon size={20} className="text-foreground" />
        </IconButton>
        <Text className="absolute left-0 right-0 text-center text-lg font-bold text-foreground pointer-events-none">
          {t('compose.languages.pickerTitle', { defaultValue: 'Post language' })}
        </Text>
        <View className="w-9 h-9 ml-auto" />
      </View>

      <View className="mx-4 mt-3 rounded-xl border-[1.5px] border-border bg-secondary px-3 py-2.5">
        <TextInput
          className="text-sm text-foreground"
          placeholder={t('compose.languages.searchPlaceholder', { defaultValue: 'Search languages' })}
          placeholderTextColor={theme.colors.textTertiary}
          value={query}
          onChangeText={setQuery}
          autoCorrect={false}
          autoCapitalize="none"
        />
      </View>

      <FlatList
        data={results}
        keyExtractor={keyExtractor}
        renderItem={renderItem}
        keyboardShouldPersistTaps="handled"
        ListEmptyComponent={
          <Text className="text-center text-sm text-muted-foreground py-6">
            {t('compose.languages.noResults', { defaultValue: 'No languages match your search' })}
          </Text>
        }
      />

      {onRemove ? (
        <TouchableOpacity
          onPress={handleRemove}
          className="flex-row items-center justify-center py-3 rounded-full mt-2 mx-4 border border-border"
          activeOpacity={0.85}
        >
          <Text className="text-sm font-semibold" style={{ color: theme.colors.error }}>
            {t('compose.languages.remove', { defaultValue: 'Remove this language' })}
          </Text>
        </TouchableOpacity>
      ) : null}
    </View>
  );
});

export default LanguagePickerSheet;
