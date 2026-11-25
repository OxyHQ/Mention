import React from 'react';
import { useTranslation } from 'react-i18next';
import { RiCheckboxCircleFill } from '@oxy.so/bloom/icons/RiCheckboxCircleFill';
import { languageLabel, translateTargets, type PostLanguageOption } from '@/utils/postLanguages';

import { type Child, HStack, Icon, RawText, VStack, toElement } from '@oxy.so/bloom-language';

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
// A language row: a touchable that dims under the finger, on the surface fill.
const languageRow = (key: string, onPress: () => void, ...content: Child[]) =>
  HStack(...content)
    .padding('horizontal', '14')
    .padding('vertical', 'md')
    .background('surface')
    .corner('lg')
    .justify('between')
    .align('center')
    .margin('bottom', 'xs')
    .pressFade('70')
    .onPress(onPress)
    .id(key);

const PostLanguageSheet: React.FC<Props> = ({ options, activeTag, onSelect }) => {
  const { t } = useTranslation();

  return toElement(
    VStack(
      RawText(t('post.language.pickerTitle', { defaultValue: 'Read this post in' }))
        .padding('horizontal', 'xs')
        .foreground('foreground')
        .margin('bottom', 'sm')
        .font('md')
        .weight('semibold'),
      options.map((option) =>
        languageRow(
          option.tag,
          () => onSelect(option.tag),
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
          option.tag === activeTag
            ? Icon(RiCheckboxCircleFill).size('md').foreground('primary')
            : null,
        ),
      ),
      RawText(t('post.language.translateTo', { defaultValue: 'Translate to' }))
        .padding('horizontal', 'xs')
        .foreground('muted')
        .margin('bottom', 'sm')
        .margin('top', 'lg')
        .font('sm')
        .weight('semibold'),
      translateTargets(options).map((language) =>
        languageRow(
          language.tag,
          () => onSelect(language.tag),
          RawText(language.nativeName)
            .foreground('foreground')
            .font('16')
            .leading('normal')
            .weight('medium'),
          RawText(language.englishName).foreground('muted').font('sm'),
        ),
      ),
    )
      .padding('all', 'lg')
      .background('background'),
  );
};

export default React.memo(PostLanguageSheet);
