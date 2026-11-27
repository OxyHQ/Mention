import { memo, useCallback, useMemo, useState } from 'react';
import { FlatList } from 'react-native';
import { useTranslation } from 'react-i18next';
import { RiCloseLine } from '@oxy.so/bloom/icons/RiCloseLine';
import { CONTENT_LANGUAGES, type ContentLanguage } from '@/constants/contentLanguages';
import {
  Button as LButton,
  Embed,
  Header,
  Icon,
  RawText,
  Search as LSearch,
  Text as LText,
  VStack,
  toElement,
  Row,
} from '@oxy.so/bloom-language';

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
      return toElement(
        Row(item.nativeName)
          .onPress(isTaken ? undefined : () => handleSelect(item.tag))
          .disabled(isTaken)
          .role('option')
          .selected(isCurrent)
          .subtitle(
            isTaken
              ? t('compose.languages.alreadyAdded', { defaultValue: 'Already added' })
              : item.englishName,
          )
          .trailing(
            isCurrent
              ? RawText(t('compose.languages.current', { defaultValue: 'Current' }))
                  .foreground('primary')
                  .font('sm')
                  .weight('semibold')
              : undefined,
          ),
      );
    },
    [currentTag, handleSelect, t, usedTags],
  );

  return toElement(
    VStack(
      Header(t('compose.languages.pickerTitle', { defaultValue: 'Post language' }))
        .titleAlign('center')
        .safeArea(false)
        .toolbarLeading(
          LButton(Icon(RiCloseLine))
            .shape('circle')
            .style('subtle')
            .tint('neutral')
            .onPress(onClose)
            .label(t('common.close', { defaultValue: 'Close' })),
        )
        .inPage(),
      VStack(
        LSearch([query, setQuery])
          .label(t('compose.languages.searchPlaceholder', { defaultValue: 'Search languages' }))
          .onClearText(() => setQuery(''))
          .autocorrect(false)
          .autocapitalize('none'),
      )
        .margin('horizontal', 'lg')
        .margin('top', 'md'),
      Embed(
        <FlatList
          data={results}
          keyExtractor={keyExtractor}
          renderItem={renderItem}
          keyboardShouldPersistTaps="handled"
          ListEmptyComponent={toElement(
            RawText(
              t('compose.languages.noResults', { defaultValue: 'No languages match your search' }),
            )
              .padding('vertical', '2xl')
              .textAlign('center')
              .font('14')
              .leading('20px')
              .foreground('muted'),
          )}
        />,
      ),
      onMakeMain || onRemove
        ? VStack(
            onMakeMain
              ? LButton(
                  LText(t('compose.languages.makeMain', { defaultValue: 'Make main language' })),
                )
                  .style('subtle')
                  .tint('neutral')
                  .size('lg')
                  .onPress(handleMakeMain)
              : null,
            onRemove
              ? LButton(
                  LText(
                    removeLabel ??
                      t('compose.languages.remove', { defaultValue: 'Remove this language' }),
                  ),
                )
                  .style('solid')
                  .tint('danger')
                  .size('lg')
                  .onPress(handleRemove)
              : null,
          )
            .margin('top', 'sm')
            .margin('horizontal', 'lg')
            .spacing('sm')
        : null,
    )
      .padding('bottom', '2xl')
      .background('background')
      .flex('1'),
  );
});

export default LanguagePickerSheet;
