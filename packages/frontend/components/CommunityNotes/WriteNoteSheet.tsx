import React, { useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Button } from '@oxy.so/bloom/button';
import { Textarea } from '@oxy.so/bloom/textarea';
import { TextField, TextFieldHint, TextFieldInput } from '@oxy.so/bloom/text-field';
import type { HydratedPostSummary } from '@mention/shared-types';
import PostItem from '@/components/Feed/PostItem';
import { NoteSheetHeader } from './NoteSheetHeader';

/** The longest note CrowdSource accepts. */
export const COMMUNITY_NOTE_MAX_LENGTH = 500;

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

  return (
    <View className="bg-background flex-1">
      <NoteSheetHeader title={t('communityNotes.write.title', { defaultValue: 'Write community note' })} onClose={onClose} />
      <ScrollView className="flex-1" contentContainerClassName="gap-4 px-4 pb-4" keyboardShouldPersistTaps="handled">
        <Textarea
          label={t('communityNotes.write.noteLabel', { defaultValue: 'Note' })}
          placeholder={t('communityNotes.write.notePlaceholder', { defaultValue: 'Add helpful context' })}
          hint={t('communityNotes.write.noteHint', { defaultValue: 'Background, a clarification or a fact that helps people understand the post.' })}
          value={text}
          onChangeText={setText}
          rows={4}
          autoResize
          maxRows={10}
          maxLength={COMMUNITY_NOTE_MAX_LENGTH}
          showCount
        />
        <View className="gap-1">
          <TextField isInvalid={sourceInvalid}>
            <TextFieldInput
              label={t('communityNotes.write.sourceLabel', { defaultValue: 'Source' })}
              placeholder="https://"
              value={sourceUrl}
              onChangeText={setSourceUrl}
              isInvalid={sourceInvalid}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
            />
          </TextField>
          <TextFieldHint isInvalid={sourceInvalid}>
            {sourceInvalid
              ? t('communityNotes.write.sourceInvalid', { defaultValue: 'Enter a full link, starting with https://' })
              : t('communityNotes.write.sourceHint', { defaultValue: 'A link to a specific page makes a helpful rating more likely.' })}
          </TextFieldHint>
        </View>
        <View pointerEvents="none">
          <PostItem post={post} isNested />
        </View>
      </ScrollView>
      <View className="border-border gap-2 border-t px-4 pb-6 pt-3">
        <Button appearance="solid" tone="accent" size="large" disabled={!canSubmit} onPress={() => onSubmit({ text: text.trim(), sourceUrl: sourceUrl.trim() })}>
          {t('communityNotes.write.submit', { defaultValue: 'Submit' })}
        </Button>
        <Text className="text-muted-foreground text-center text-[12px]">
          {t('communityNotes.write.footer', { defaultValue: "Community notes are anonymous. You can't edit a note after you submit it." })}
        </Text>
      </View>
    </View>
  );
}
