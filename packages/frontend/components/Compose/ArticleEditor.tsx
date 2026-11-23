import type React from 'react';
import { useTranslation } from 'react-i18next';

import {
  Dialog as LDialog,
  RawText,
  TextEditor,
  TextField,
  VStack,
  toElement,
} from '@oxy.so/bloom-language';

interface ArticleEditorProps {
  visible: boolean;
  title: string;
  body: string;
  onTitleChange: (title: string) => void;
  onBodyChange: (body: string) => void;
  onSave: () => void;
  onClose: () => void;
}

/**
 * The long-form writing surface behind the composer's "article" attachment.
 *
 * It renders through bloom's `Dialog`, NOT a hand-rolled RN `<Modal>`. That is a
 * layering decision rather than a styling one: a raw `Modal` gets its own native
 * window, which sits outside any ordering the design system can apply, so an
 * overlay opened from inside it — a confirm prompt, a picker — has no way to
 * paint above it. Everything on bloom's surface stack orders against everything
 * else; a bare `Modal` orders against nothing.
 *
 * The Dialog also owns what this component used to hand-roll: the safe-area
 * insets, the keyboard-avoiding behaviour while a long body is being typed, the
 * scroll container, and the header with its close affordance. `placement` is the
 * app's usual dialog-to-sheet pair — a near-full-height sheet on a phone, where
 * that is the native shape for a writing surface, and a wide centered card on a
 * desktop, where prose reads better than a 460px drawer.
 *
 * Every value is controlled by the composer, which owns the draft: this
 * component holds no copy of the title or body, so opening, typing, closing and
 * reopening cannot lose them.
 */
export const ArticleEditor: React.FC<ArticleEditorProps> = ({
  visible,
  title,
  body,
  onTitleChange,
  onBodyChange,
  onSave,
  onClose,
}) => {
  const { t } = useTranslation();

  const saveAction = toElement(
    VStack(
      RawText(t('common.save')).font('14').leading('20px').weight('semibold').foreground('card'),
    )
      .padding('horizontal', 'lg')
      .padding('vertical', 'sm')
      .background('primary')
      .corner('infinite')
      .onPress(onSave)
      .role('button')
      .pressFade('85'),
  );

  return toElement(
    LDialog(
      VStack(
        TextField(
          [title, onTitleChange],
          t('compose.article.titlePlaceholder', {
            defaultValue: 'Article title',
          }),
        ).maxLength(280),
        TextEditor([body, onBodyChange])
          .label(
            t('compose.article.bodyPlaceholder', {
              defaultValue: 'Start writing…',
            }),
          )
          .placeholder(
            t('compose.article.bodyPlaceholder', {
              defaultValue: 'Start writing…',
            }),
          )
          .rows(12)
          .autoResize(40),
      )
        .padding('bottom', '2xl')
        .spacing('lg'),
    )
      .presentAt('bottom', { md: 'center' })
      .frame({ maxWidth: '720' })
      .maxHeightRatio(0.92)
      .header({
        title: t('compose.article.editorTitle', { defaultValue: 'Write article' }),
        largeTitle: false,
        right: saveAction,
      })
      .testID('articleEditorDialog')
      .presented([visible, () => onClose()]),
  );
};
