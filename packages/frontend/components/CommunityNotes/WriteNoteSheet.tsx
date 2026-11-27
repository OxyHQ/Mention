import { useState } from 'react';
import { ScrollView, type ViewStyle } from 'react-native';
import { useTranslation } from 'react-i18next';
import { TextFieldHint } from '@oxy.so/bloom/text-field';
import type { HydratedPostSummary } from '@mention/shared-types';
import PostItem from '@/components/Feed/PostItem';
import { NoteSheetHeader } from './NoteSheetHeader';

import {
  Button as LButton,
  Embed,
  RawText,
  Text as LText,
  VStack,
  toElement,
} from '@oxy.so/bloom-language';
import { TextEditor, TextField } from '@oxy.so/bloom-language/inputs';

// The scroll's classes as plain objects (inline, as the classes were).
const FILL_STYLE: ViewStyle = { flexGrow: 1, flexShrink: 1, flexBasis: '0%' };
const CONTENT_STYLE: ViewStyle = { gap: 16, paddingInline: 16, paddingBottom: 16 };

/** The longest note CrowdSource accepts. */
const COMMUNITY_NOTE_MAX_LENGTH = 500;

export interface CommunityNoteDraft {
  text: string;
  sourceUrl: string;
}

interface WriteNoteSheetProps {
  post: HydratedPostSummary;
  onSubmit: (draft: CommunityNoteDraft) => void;
  onClose: () => void;
}

const isHttpUrl = (value: string) => /^https?:\/\/\S+\.\S+/i.test(value.trim());

/**
 * The note form: the context, a source, and the post it is about — so the
 * writer re-reads what they are annotating. A note cannot be edited once sent,
 * which the footer says before they send it.
 */
export function WriteNoteSheet({ post, onSubmit, onClose }: WriteNoteSheetProps) {
  const { t } = useTranslation();
  const [text, setText] = useState('');
  const [sourceUrl, setSourceUrl] = useState('');
  const sourceInvalid = sourceUrl.trim().length > 0 && !isHttpUrl(sourceUrl);
  const canSubmit = text.trim().length > 0 && !sourceInvalid;

  return toElement(
    VStack(
      Embed(
        <NoteSheetHeader
          title={t('communityNotes.write.title', { defaultValue: 'Write community note' })}
          onClose={onClose}
        />,
      ),
      Embed(
        <ScrollView
          style={FILL_STYLE}
          contentContainerStyle={CONTENT_STYLE}
          keyboardShouldPersistTaps="handled"
        >
          {toElement(
            TextEditor(
              [text, setText],
              t('communityNotes.write.noteLabel', { defaultValue: 'Note' }),
            )
              .placeholder(
                t('communityNotes.write.notePlaceholder', {
                  defaultValue: 'Add helpful context',
                }),
              )
              .description(
                t('communityNotes.write.noteHint', {
                  defaultValue:
                    'Background, a clarification or a fact that helps people understand the post.',
                }),
              )
              .rows(4)
              .autoResize(10)
              .maxLength(COMMUNITY_NOTE_MAX_LENGTH)
              .showCount(),
          )}
          {toElement(
            VStack(
              TextField(
                [sourceUrl, setSourceUrl],
                t('communityNotes.write.sourceLabel', { defaultValue: 'Source' }),
              )
                .placeholder('https://')
                .invalid(sourceInvalid)
                .autocapitalize('none')
                .autocorrect(false)
                .keyboard('url'),
              Embed(
                <TextFieldHint isInvalid={sourceInvalid}>
                  {sourceInvalid
                    ? t('communityNotes.write.sourceInvalid', {
                        defaultValue: 'Enter a full link, starting with https://',
                      })
                    : t('communityNotes.write.sourceHint', {
                        defaultValue:
                          'A link to a specific page makes a helpful rating more likely.',
                      })}
                </TextFieldHint>,
              ),
            ).spacing('xs'),
          )}
          {toElement(VStack(Embed(<PostItem post={post} isNested />)).allowsHitTesting(false))}
        </ScrollView>,
      ),
      VStack(
        LButton(LText(t('communityNotes.write.submit', { defaultValue: 'Submit' })))
          .style('solid')
          .tint('accent')
          .size('lg')
          .disabled(!canSubmit)
          .onPress(() => onSubmit({ text: text.trim(), sourceUrl: sourceUrl.trim() })),
        RawText(
          t('communityNotes.write.footer', {
            defaultValue:
              "Community notes are anonymous. You can't edit a note after you submit it.",
          }),
        )
          .foreground('muted')
          .textAlign('center')
          .font('xs'),
      )
        .padding('horizontal', 'lg')
        .padding('bottom', '2xl')
        .padding('top', 'md')
        .border('border', 'thin', 'top')
        .spacing('sm'),
    )
      .background('background')
      .flex('1'),
  );
}
