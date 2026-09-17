import React from 'react';
import { Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Button } from '@oxy.so/bloom/button';
import { RiSettings3Line, RiTeamLine, RiThumbUpLine } from '@oxy.so/bloom/icons';
import { NoteTipList } from './NoteTipList';

interface NoteSubmittedSheetProps {
  onDone: () => void;
  onManageNotes: () => void;
}

/** After submitting: what happens to the note next. */
export function NoteSubmittedSheet({ onDone, onManageNotes }: NoteSubmittedSheetProps) {
  const { t } = useTranslation();
  return (
    <View className="bg-background gap-6 px-5 pb-6 pt-6">
      <View className="gap-1">
        <Text className="text-foreground text-center text-[22px] font-bold">
          {t('communityNotes.submitted.title', { defaultValue: 'Your community note was submitted' })}
        </Text>
        <Text className="text-muted-foreground text-center text-[14px]">
          {t('communityNotes.submitted.subtitle', { defaultValue: "Here's what happens next" })}
        </Text>
      </View>
      <NoteTipList
        tips={[
          {
            icon: RiThumbUpLine,
            title: t('communityNotes.submitted.ratedTitle', { defaultValue: 'Your note can be rated' }),
            body: t('communityNotes.submitted.ratedBody', { defaultValue: 'Other contributors can see your note and decide if it is helpful.' }),
          },
          {
            icon: RiTeamLine,
            title: t('communityNotes.submitted.shownTitle', { defaultValue: 'Ratings decide if it is shown' }),
            body: t('communityNotes.submitted.shownBody', { defaultValue: "If people who usually disagree both find it helpful, it's added to the post and you'll get a notification." }),
          },
          {
            icon: RiSettings3Line,
            title: t('communityNotes.submitted.manageTitle', { defaultValue: 'Manage your notes' }),
            body: t('communityNotes.submitted.manageBody', { defaultValue: 'See or delete the notes you wrote and rate notes from others.' }),
          },
        ]}
      />
      <View className="gap-2">
        <Button variant="primary" size="large" onPress={onDone}>
          {t('communityNotes.submitted.done', { defaultValue: 'Done' })}
        </Button>
        <Button variant="outline" size="large" onPress={onManageNotes}>
          {t('communityNotes.submitted.manage', { defaultValue: 'Manage notes' })}
        </Button>
      </View>
    </View>
  );
}
