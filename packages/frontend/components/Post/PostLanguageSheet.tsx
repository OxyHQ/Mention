import React from 'react';
import { Text, TouchableOpacity, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useTranslation } from 'react-i18next';
import { useTheme } from '@oxyhq/bloom/theme';
import { languageLabel, translateTargets, type PostLanguageOption } from '@/utils/postLanguages';

interface Props {
  /** The renditions this post can be read in right now. */
  options: readonly PostLanguageOption[];
  /** The one on screen, ticked. */
  activeTag: string | null;
  onSelect: (tag: string) => void;
}

/**
 * Reading a post in a language nobody asked the action bar for.
 *
 * The action bar's translate icon answers the only question most readers have —
 * "put this in MY language" — in one tap. This sheet is the rest: the renditions
 * the post already carries, and the whole language catalog under them. It has no
 * standing surface, because a multilingual post is still one post and must not
 * grow a toolbar; `usePostLanguagePicker` is what opens it.
 *
 * The catalog is offered whole, never an inventory of the translations that
 * happen to exist: the server takes any valid tag and decides for itself whether
 * serving it costs a cache read or a model call. A reader is never shown a
 * shorter menu because a cache is cold.
 */
const PostLanguageSheet: React.FC<Props> = ({ options, activeTag, onSelect }) => {
  const { t } = useTranslation();
  const theme = useTheme();

  return (
    <View className="bg-background p-4">
      <Text className="text-foreground mb-2 px-1 text-[15px] font-semibold">
        {t('post.language.pickerTitle', { defaultValue: 'Read this post in' })}
      </Text>
      {options.map((option) => (
        <TouchableOpacity
          key={option.tag}
          className="bg-surface mb-1 flex-row items-center justify-between rounded-2xl px-3.5 py-3"
          activeOpacity={0.7}
          onPress={() => onSelect(option.tag)}
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
          onPress={() => onSelect(language.tag)}
        >
          <Text className="text-foreground text-base font-medium">{language.nativeName}</Text>
          <Text className="text-muted-foreground text-[13px]">{language.englishName}</Text>
        </TouchableOpacity>
      ))}
    </View>
  );
};

export default React.memo(PostLanguageSheet);
