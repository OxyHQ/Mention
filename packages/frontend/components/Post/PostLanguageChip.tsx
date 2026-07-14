import React, { useCallback, useContext, useMemo } from 'react';
import { GestureResponderEvent, Pressable, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { useTheme } from '@oxyhq/bloom/theme';
import { SpinnerIcon } from '@oxyhq/bloom/loading';
import { BottomSheetContext } from '@/context/BottomSheetContext';
import { languageLabel, translateTargets, type PostLanguageOption } from '@/utils/postLanguages';

const CHIP_ICON_SIZE = 13;

interface Props {
  /** The renditions this post shipped with. Fewer than two = no chip. */
  options: readonly PostLanguageOption[];
  /** The language currently on screen. */
  activeTag: string | null;
  isTranslating?: boolean;
  onSelect: (tag: string) => void;
}

/**
 * "Showing in Español · View in English".
 *
 * A quiet line under the body, not a toolbar: a multilingual post is still one
 * post. It appears only when there is somewhere else to go — a post with a
 * single rendition never grows a control that does nothing. (Translating such a
 * post is the action bar's job; once translated it HAS a second rendition, so
 * the chip appears then.)
 *
 * With exactly one alternative the chip switches straight to it — the whole
 * bilingual case, and instant, because that body shipped with the post. With
 * more, it opens a picker listing the renditions AND the rest of the language
 * catalog: a language the post has never been translated into is offered exactly
 * like one it has, because the server takes any tag and decides for itself
 * whether serving it costs a cache read or a model call. The reader is never
 * shown a shorter menu because a cache happens to be cold.
 */
const PostLanguageChip: React.FC<Props> = ({ options, activeTag, isTranslating = false, onSelect }) => {
  const { t } = useTranslation();
  const theme = useTheme();
  const bottomSheet = useContext(BottomSheetContext);

  const active = useMemo(
    () => options.find((option) => option.tag === activeTag) ?? null,
    [options, activeTag],
  );
  const alternatives = useMemo(
    () => options.filter((option) => option.tag !== activeTag),
    [options, activeTag],
  );

  const closeSheet = useCallback(() => {
    bottomSheet.setBottomSheetContent(null);
    bottomSheet.openBottomSheet(false);
  }, [bottomSheet]);

  const openPicker = useCallback(() => {
    const select = (tag: string) => {
      closeSheet();
      onSelect(tag);
    };

    bottomSheet.setBottomSheetContent(
      <View className="bg-background p-4">
        <Text className="text-foreground mb-2 px-1 text-[15px] font-semibold">
          {t('post.language.pickerTitle', { defaultValue: 'Read this post in' })}
        </Text>
        {options.map((option) => (
          <TouchableOpacity
            key={option.tag}
            className="bg-surface mb-1 flex-row items-center justify-between rounded-2xl px-3.5 py-3"
            activeOpacity={0.7}
            onPress={() => select(option.tag)}
          >
            <View>
              <Text className="text-foreground text-base font-medium">{languageLabel(option.tag)}</Text>
              {option.source === 'machine' ? (
                <Text className="text-muted-foreground text-[13px]">
                  {t('post.language.machine', { defaultValue: 'Translated' })}
                </Text>
              ) : null}
            </View>
            {option.tag === activeTag ? (
              <Ionicons name="checkmark-circle" size={20} color={theme.colors.primary} />
            ) : null}
          </TouchableOpacity>
        ))}

        <Text className="text-muted-foreground mb-2 mt-4 px-1 text-[13px] font-semibold">
          {t('post.language.translateTo', { defaultValue: 'Translate to' })}
        </Text>
        {translateTargets(options).map((language) => (
          <TouchableOpacity
            key={language.tag}
            className="bg-surface mb-1 flex-row items-center justify-between rounded-2xl px-3.5 py-3"
            activeOpacity={0.7}
            onPress={() => select(language.tag)}
          >
            <Text className="text-foreground text-base font-medium">{language.nativeName}</Text>
            <Text className="text-muted-foreground text-[13px]">{language.englishName}</Text>
          </TouchableOpacity>
        ))}
      </View>,
    );
    bottomSheet.openBottomSheet(true);
  }, [bottomSheet, options, activeTag, onSelect, closeSheet, t, theme.colors.primary]);

  const handlePress = useCallback(
    (event: GestureResponderEvent) => {
      // The chip lives inside the post's own press target: switching the
      // language must never open the post detail underneath it.
      event.stopPropagation?.();
      if (alternatives.length === 1) {
        onSelect(alternatives[0].tag);
        return;
      }
      openPicker();
    },
    [alternatives, onSelect, openPicker],
  );

  if (options.length < 2 || !active) return null;

  const activeName = languageLabel(active.tag);
  const showingLabel =
    active.source === 'machine'
      ? t('post.language.showingTranslation', {
          language: activeName,
          defaultValue: 'Translated to {{language}}',
        })
      : t('post.language.showingIn', {
          language: activeName,
          defaultValue: 'Showing in {{language}}',
        });
  const actionLabel =
    alternatives.length === 1
      ? t('post.language.viewIn', {
          language: languageLabel(alternatives[0].tag),
          defaultValue: 'View in {{language}}',
        })
      : t('post.language.otherLanguages', { defaultValue: 'Other languages' });

  return (
    <View className="mt-1.5 flex-row items-center gap-1">
      <Ionicons name="language-outline" size={CHIP_ICON_SIZE} color={theme.colors.textSecondary} />
      <Text className="text-muted-foreground text-[13px]" numberOfLines={1}>
        {showingLabel}
      </Text>
      <Text className="text-muted-foreground text-[13px]">{'·'}</Text>
      {isTranslating ? (
        <SpinnerIcon size={CHIP_ICON_SIZE} className="text-muted-foreground" />
      ) : (
        <Pressable
          onPress={handlePress}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          accessibilityRole="button"
          accessibilityLabel={actionLabel}
        >
          <Text className="text-primary text-[13px] font-semibold" numberOfLines={1}>
            {actionLabel}
          </Text>
        </Pressable>
      )}
    </View>
  );
};

export default React.memo(PostLanguageChip);
