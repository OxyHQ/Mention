import React, { memo, useCallback, useMemo, useState } from 'react';
import { FlatList, Text, TextInput, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Button } from '@oxy.so/bloom/button';
import { RiCloseLine } from '@oxy.so/bloom/icons';
import { PageHeader } from '@oxy.so/bloom/page-header';
import { Item } from '@oxy.so/bloom/item';
import { useTheme } from '@oxy.so/bloom/theme';
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
  /** Overrides the remove button's label (e.g. "Use automatic" in settings). */
  removeLabel?: string;
  /**
   * Promotes this NON-PRIMARY language to the post's primary. Offered next to
   * Remove when an existing secondary tab is being edited.
   */
  onMakeMain?: () => void;
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
  removeLabel,
  onMakeMain,
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

  const handleMakeMain = useCallback(() => {
    onMakeMain?.();
    onClose();
  }, [onMakeMain, onClose]);

  const renderItem = useCallback(
    ({ item }: { item: ContentLanguage }) => {
      const isCurrent = item.tag === currentTag;
      const isTaken = !isCurrent && usedTags.includes(item.tag);
      return (
        <Item
          onPress={isTaken ? undefined : () => handleSelect(item.tag)}
          disabled={isTaken}
          role="option"
          selected={isCurrent}
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
      <PageHeader
        title={t('compose.languages.pickerTitle', { defaultValue: 'Post language' })}
        titleAlign="center"
        safeArea={false}
        leading={
          <Button
            variant="secondary"
            iconOnly
            leadingIcon={RiCloseLine}
            onPress={onClose}
            accessibilityLabel={t('common.close', { defaultValue: 'Close' })}
          />
        }
      />

      <View className="mx-4 mt-3 rounded-xl border-[1.5px] border-border bg-muted px-3 py-2.5">
        <TextInput
          className="text-sm text-foreground"
          placeholder={t('compose.languages.searchPlaceholder', { defaultValue: 'Search languages' })}
          accessibilityLabel={t('compose.languages.searchPlaceholder', { defaultValue: 'Search languages' })}
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

      {onMakeMain || onRemove ? (
        <View className="mt-2 mx-4 gap-2">
          {onMakeMain ? (
            <Button variant="secondary" size="large" onPress={handleMakeMain}>
              {t('compose.languages.makeMain', { defaultValue: 'Make main language' })}
            </Button>
          ) : null}
          {onRemove ? (
            <Button variant="destructive" size="large" onPress={handleRemove}>
              {removeLabel ?? t('compose.languages.remove', { defaultValue: 'Remove this language' })}
            </Button>
          ) : null}
        </View>
      ) : null}
    </View>
  );
});

export default LanguagePickerSheet;
