import { useTranslation } from 'react-i18next';
import { RiSettings3Line } from '@oxy.so/bloom/icons/RiSettings3Line';
import { RiTeamLine } from '@oxy.so/bloom/icons/RiTeamLine';
import { RiThumbUpLine } from '@oxy.so/bloom/icons/RiThumbUpLine';
import { NoteTipList } from './NoteTipList';

import {
  Button as LButton,
  Embed,
  RawText,
  Text as LText,
  VStack,
  toElement,
} from '@oxy.so/bloom-language';

interface NoteSubmittedSheetProps {
  onDone: () => void;
  onManageNotes: () => void;
}

/** After submitting: what happens to the note next. */
export function NoteSubmittedSheet({ onDone, onManageNotes }: NoteSubmittedSheetProps) {
  const { t } = useTranslation();
  return toElement(
    VStack(
      VStack(
        RawText(
          t('communityNotes.submitted.title', {
            defaultValue: 'Your community note was submitted',
          }),
        )
          .foreground('foreground')
          .textAlign('center')
          .font('2xl')
          .weight('bold'),
        RawText(
          t('communityNotes.submitted.subtitle', { defaultValue: "Here's what happens next" }),
        )
          .foreground('muted')
          .textAlign('center')
          .font('14'),
      ).spacing('xs'),
      Embed(
        <NoteTipList
          tips={[
            {
              icon: RiThumbUpLine,
              title: t('communityNotes.submitted.ratedTitle', {
                defaultValue: 'Your note can be rated',
              }),
              body: t('communityNotes.submitted.ratedBody', {
                defaultValue: 'Other contributors can see your note and decide if it is helpful.',
              }),
            },
            {
              icon: RiTeamLine,
              title: t('communityNotes.submitted.shownTitle', {
                defaultValue: 'Ratings decide if it is shown',
              }),
              body: t('communityNotes.submitted.shownBody', {
                defaultValue:
                  "If people who usually disagree both find it helpful, it's added to the post and you'll get a notification.",
              }),
            },
            {
              icon: RiSettings3Line,
              title: t('communityNotes.submitted.manageTitle', {
                defaultValue: 'Manage your notes',
              }),
              body: t('communityNotes.submitted.manageBody', {
                defaultValue: 'See or delete the notes you wrote and rate notes from others.',
              }),
            },
          ]}
        />,
      ),
      VStack(
        LButton(LText(t('communityNotes.submitted.done', { defaultValue: 'Done' })))
          .style('solid')
          .tint('accent')
          .size('lg')
          .onPress(onDone),
        LButton(LText(t('communityNotes.submitted.manage', { defaultValue: 'Manage notes' })))
          .style('outline')
          .tint('neutral')
          .size('lg')
          .onPress(onManageNotes),
      ).spacing('sm'),
    )
      .padding('horizontal', 'xl')
      .padding('bottom', '2xl')
      .padding('top', '2xl')
      .background('background')
      .spacing('2xl'),
  );
}
