import { useTranslation } from 'react-i18next';
import { RiEditLine } from '@oxy.so/bloom/icons/RiEditLine';
import { RiEyeOffLine } from '@oxy.so/bloom/icons/RiEyeOffLine';
import { RiFileTextLine } from '@oxy.so/bloom/icons/RiFileTextLine';
import { RiLinkM } from '@oxy.so/bloom/icons/RiLinkM';
import { NoteSheetHeader } from './NoteSheetHeader';
import { NoteTipList } from './NoteTipList';

import {
  Button as LButton,
  Embed,
  RawText,
  Text as LText,
  VStack,
  toElement,
} from '@oxy.so/bloom-language';

interface WritingTipsSheetProps {
  onContinue: () => void;
  onLearnMore: () => void;
  onClose: () => void;
}

/** First step of writing a note: what makes one helpful, before the form. */
export function WritingTipsSheet({ onContinue, onLearnMore, onClose }: WritingTipsSheetProps) {
  const { t } = useTranslation();
  return toElement(
    VStack(
      Embed(<NoteSheetHeader onClose={onClose} />),
      VStack(
        RawText(t('communityNotes.tips.title', { defaultValue: 'Write a helpful community note' }))
          .foreground('foreground')
          .textAlign('center')
          .font('2xl')
          .weight('bold'),
        Embed(
          <NoteTipList
            tips={[
              {
                icon: RiEditLine,
                body: t('communityNotes.tips.context', {
                  defaultValue: 'Add background for posts that might be misleading or confusing.',
                }),
              },
              {
                icon: RiFileTextLine,
                body: t('communityNotes.tips.neutral', {
                  defaultValue: 'Use language that is neutral, unbiased and easy to understand.',
                }),
              },
              {
                icon: RiLinkM,
                body: t('communityNotes.tips.source', {
                  defaultValue: 'Back up what you write with a link to a reliable source.',
                }),
              },
              {
                icon: RiEyeOffLine,
                body: t('communityNotes.tips.anonymous', {
                  defaultValue:
                    'Community notes are anonymous. Nobody can see who wrote or rated a note.',
                }),
              },
            ]}
          />,
        ),
        VStack(
          LButton(LText(t('communityNotes.tips.continue', { defaultValue: 'Continue' })))
            .style('solid')
            .tint('accent')
            .size('lg')
            .onPress(onContinue),
          LButton(LText(t('communityNotes.learnMore', { defaultValue: 'Learn more' })))
            .style('outline')
            .tint('neutral')
            .size('lg')
            .onPress(onLearnMore),
        ).spacing('sm'),
      )
        .padding('horizontal', 'xl')
        .spacing('2xl'),
    )
      .padding('bottom', '2xl')
      .background('background'),
  );
}
