import React from 'react';
import { Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Button } from '@oxy.so/bloom/button';
import { RiEditLine, RiEyeOffLine, RiFileTextLine, RiLinkM } from '@oxy.so/bloom/icons';
import { NoteSheetHeader } from './NoteSheetHeader';
import { NoteTipList } from './NoteTipList';

interface WritingTipsSheetProps {
  onContinue: () => void;
  onLearnMore: () => void;
  onClose: () => void;
}

/** First step of writing a note: what makes one helpful, before the form. */
export function WritingTipsSheet({ onContinue, onLearnMore, onClose }: WritingTipsSheetProps) {
  const { t } = useTranslation();
  return (
    <View className="bg-background pb-6">
      <NoteSheetHeader onClose={onClose} />
      <View className="gap-6 px-5">
        <Text className="text-foreground text-center text-[22px] font-bold">
          {t('communityNotes.tips.title', { defaultValue: 'Write a helpful community note' })}
        </Text>
        <NoteTipList
          tips={[
            { icon: RiEditLine, body: t('communityNotes.tips.context', { defaultValue: 'Add background for posts that might be misleading or confusing.' }) },
            { icon: RiFileTextLine, body: t('communityNotes.tips.neutral', { defaultValue: 'Use language that is neutral, unbiased and easy to understand.' }) },
            { icon: RiLinkM, body: t('communityNotes.tips.source', { defaultValue: 'Back up what you write with a link to a reliable source.' }) },
            { icon: RiEyeOffLine, body: t('communityNotes.tips.anonymous', { defaultValue: "Community notes are anonymous. Nobody can see who wrote or rated a note." }) },
          ]}
        />
        <View className="gap-2">
          <Button variant="primary" size="large" onPress={onContinue}>
            {t('communityNotes.tips.continue', { defaultValue: 'Continue' })}
          </Button>
          <Button variant="outline" size="large" onPress={onLearnMore}>
            {t('communityNotes.learnMore', { defaultValue: 'Learn more' })}
          </Button>
        </View>
      </View>
    </View>
  );
}
