import React from 'react';
import { TouchableOpacity } from 'react-native';
import { useTranslation } from 'react-i18next';
import { createTokenStyles } from '@oxy.so/bloom/theme';
import { RiCheckboxCircleFill } from '@oxy.so/bloom/icons/RiCheckboxCircleFill';
import { languageLabel, translateTargets, type PostLanguageOption } from '@/utils/postLanguages';

import { Embed, Icon, RawText, VStack, toElement } from '@oxy.so/bloom-language';

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
// A language row: a touchable that dims under the finger (the language's press
// variant has no timed opacity), on the surface fill.
const useOptionStyles = createTokenStyles((t) => ({
  option: {
    backgroundColor: t.surface,
    marginBottom: 4,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderRadius: 16,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
}));

const PostLanguageSheet: React.FC<Props> = ({ options, activeTag, onSelect }) => {
  const { t } = useTranslation();
  const styles = useOptionStyles();

  return toElement(
    VStack(
      RawText(t('post.language.pickerTitle', { defaultValue: 'Read this post in' }))
        .padding('horizontal', 'xs')
        .foreground('foreground')
        .margin('bottom', 'sm')
        .font('md')
        .weight('semibold'),
      Embed(
        options.map((option) => (
          <TouchableOpacity
            key={option.tag}
            style={styles.option}
            activeOpacity={0.7}
            onPress={() => onSelect(option.tag)}
          >
            {toElement(
              VStack(
                RawText(languageLabel(option.tag))
                  .foreground('foreground')
                  .font('16')
                  .leading('normal')
                  .weight('medium'),
                option.source === 'machine'
                  ? RawText(t('post.language.machine', { defaultValue: 'Translated' }))
                      .foreground('muted')
                      .font('sm')
                  : null,
              ),
            )}
            {option.tag === activeTag
              ? toElement(Icon(RiCheckboxCircleFill).size('md').foreground('primary'))
              : null}
          </TouchableOpacity>
        )),
      ),
      RawText(t('post.language.translateTo', { defaultValue: 'Translate to' }))
        .padding('horizontal', 'xs')
        .foreground('muted')
        .margin('bottom', 'sm')
        .margin('top', 'lg')
        .font('sm')
        .weight('semibold'),
      Embed(
        translateTargets(options).map((language) => (
          <TouchableOpacity
            key={language.tag}
            style={styles.option}
            activeOpacity={0.7}
            onPress={() => onSelect(language.tag)}
          >
            {toElement(
              RawText(language.nativeName)
                .foreground('foreground')
                .font('16')
                .leading('normal')
                .weight('medium'),
            )}
            {toElement(RawText(language.englishName).foreground('muted').font('sm'))}
          </TouchableOpacity>
        )),
      ),
    )
      .padding('all', 'lg')
      .background('background'),
  );
};

export default React.memo(PostLanguageSheet);
