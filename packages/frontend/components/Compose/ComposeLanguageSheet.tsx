import React, { memo, useCallback } from 'react';
import { Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Item } from '@oxy.so/bloom/item';
import { useTheme } from '@oxy.so/bloom/theme';
import { CheckCircleIcon } from '@/assets/icons/check-circle-icon';
import { CloseIcon } from '@/assets/icons/close-icon';
import { IconButton } from '@/components/ui/Button';
import { describeContentLanguage } from '@/constants/contentLanguages';

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

  return (
    <View className="flex-1 pb-6 bg-background">
      <View className="flex-row items-center px-4 py-2 min-h-[48px] border-b border-border">
        <IconButton
          variant="icon"
          onPress={onClose}
          accessibilityLabel={t('common.close', { defaultValue: 'Close' })}
          className="mr-1.5 z-[1]"
        >
          <CloseIcon size={20} className="text-foreground" />
        </IconButton>
        <Text className="absolute left-0 right-0 text-center text-lg font-bold text-foreground pointer-events-none">
          {t('compose.languages.sheetTitle', { defaultValue: 'Post languages' })}
        </Text>
        <View className="w-9 h-9 ml-auto" />
      </View>

      <Item
        onPress={() => onEdit(primaryTag)}
        title={t('compose.languages.pickerTitle', { defaultValue: 'Post language' })}
        subtitle={describeContentLanguage(primaryTag).nativeName}
        leading={<Ionicons name="language-outline" size={20} color={theme.colors.text} />}
        trailing={<Ionicons name="chevron-forward" size={18} color={theme.colors.textTertiary} />}
      />

      {variantTags.length > 0 ? tags.map((tag) => {
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
              isActive ? <CheckCircleIcon size={20} color={theme.colors.primary} /> : undefined
            }
          />
        );
      }) : null}

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
          <Ionicons
            name="add"
            size={20}
            color={canAdd ? theme.colors.text : theme.colors.textTertiary}
          />
        }
      />
    </View>
  );
});

export default ComposeLanguageSheet;
