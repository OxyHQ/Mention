import { memo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { RiAddLine } from '@oxy.so/bloom/icons/RiAddLine';
import { RiArrowRightSLine } from '@oxy.so/bloom/icons/RiArrowRightSLine';
import { RiCheckboxCircleFill } from '@oxy.so/bloom/icons/RiCheckboxCircleFill';
import { RiCloseLine } from '@oxy.so/bloom/icons/RiCloseLine';
import { RiGlobalLine } from '@oxy.so/bloom/icons/RiGlobalLine';
import { Item } from '@oxy.so/bloom/item';
import { useTheme } from '@oxy.so/bloom/theme';
import { describeContentLanguage } from '@/constants/contentLanguages';

import {
  Button as LButton,
  Embed,
  Header,
  Icon,
  Row,
  VStack,
  toElement,
} from '@oxy.so/bloom-language';

interface ComposeLanguageSheetProps {
  /** The language the post declares — what the feed and federation read. */
  primaryTag: string;
  /** Additional author renditions, in the order they were added. */
  variantTags: readonly string[];
  /** The language the composer is currently editing. */
  activeTag: string;
  /** False once the post holds the maximum author languages. */
  canAdd: boolean;
  /** Switch the WHOLE composer — every box — to another language. */
  onSelect: (tag: string) => void;
  /** Change what a language IS: re-tag it, promote it, remove it. */
  onEdit: (tag: string) => void;
  /** Declare another language for the post. */
  onAdd: () => void;
  onClose: () => void;
}

/**
 * The post's languages, as a sheet rather than a permanent strip.
 *
 * IT REPLACED A ROW OF CHIPS that sat above the composer on every post,
 * including the overwhelmingly common single-language one, where it offered a
 * tab with nowhere to switch. The languages now live behind the pill in the
 * composer's bottom bar, beside the other whole-batch decisions (when it
 * publishes, who may reply) — which is what they are: declaring a language
 * declares it for the main post and every thread item at once.
 *
 * Changing the primary and adding another rendition are separate actions. The
 * first row always replaces the declared primary directly; the language rows
 * below it exist only when there are renditions to switch between.
 */
const ComposeLanguageSheet = memo(function ComposeLanguageSheet({
  primaryTag,
  variantTags,
  activeTag,
  canAdd,
  onSelect,
  onEdit,
  onAdd,
  onClose,
}: ComposeLanguageSheetProps) {
  const { t } = useTranslation();
  const theme = useTheme();

  /**
   * Only a SWITCH closes this sheet.
   *
   * The other two moves hand over to the language picker, which lives in the
   * same bottom-sheet host: it calls `present()` on the one ref, and a `close()`
   * from here is `dismiss()` on that same ref — so dismissing "this" sheet
   * dismisses the picker that just replaced it, one frame after it opened.
   * Editing and adding a language were therefore unreachable.
   */
  const handlePress = useCallback(
    (tag: string) => {
      if (tag === activeTag) {
        onEdit(tag);
        return;
      }
      onSelect(tag);
      onClose();
    },
    [activeTag, onEdit, onSelect, onClose],
  );

  const tags = [primaryTag, ...variantTags];

  return toElement(
    VStack(
      Header(t('compose.languages.sheetTitle', { defaultValue: 'Post languages' }))
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
      Row(t('compose.languages.pickerTitle', { defaultValue: 'Post language' }))
        .onPress(() => onEdit(primaryTag))
        .subtitle(describeContentLanguage(primaryTag).nativeName)
        .leadingView(Icon(RiGlobalLine).size('md').foreground('foreground'))
        .trailing(Icon(RiArrowRightSLine).size('18').foreground('textTertiary')),
      Embed(
        variantTags.length > 0
          ? tags.map((tag) => {
              const language = describeContentLanguage(tag);
              const isActive = tag === activeTag;
              return (
                <Item
                  key={tag}
                  onPress={() => handlePress(tag)}
                  role="option"
                  selected={isActive}
                  title={language.nativeName}
                  subtitle={
                    tag === primaryTag
                      ? t('compose.languages.main', { defaultValue: 'Main language' })
                      : language.englishName
                  }
                  trailing={
                    isActive
                      ? toElement(Icon(RiCheckboxCircleFill).size('md').foreground('primary'))
                      : undefined
                  }
                />
              );
            })
          : null,
      ),
      Embed(
        <Item
          // Item forwards the native press event. Keep the component's callback
          // contract argument-free so ADD can never be mistaken for EDIT.
          onPress={canAdd ? () => onAdd() : undefined}
          disabled={!canAdd}
          title={t('compose.languages.add', { defaultValue: 'Add language' })}
          subtitle={
            canAdd
              ? undefined
              : t('compose.languages.addFull', {
                  defaultValue: 'This post already holds every language it can',
                })
          }
          leading={
            <RiAddLine size="md" fill={canAdd ? theme.colors.text : theme.colors.textTertiary} />
          }
        />,
      ),
    )
      .padding('bottom', '2xl')
      .background('background')
      .flex('1'),
  );
});

export default ComposeLanguageSheet;
