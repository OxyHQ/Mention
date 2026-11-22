import { ScrollView, type ViewStyle } from 'react-native';
import { useTranslation } from 'react-i18next';
import { RiEyeOffLine } from '@oxy.so/bloom/icons/RiEyeOffLine';
import { RiTeamLine } from '@oxy.so/bloom/icons/RiTeamLine';
import { RiThumbUpLine } from '@oxy.so/bloom/icons/RiThumbUpLine';
import type { CommunityNoteRating, CommunityNoteSummary } from '@mention/shared-types';
import { NoteSheetHeader } from './NoteSheetHeader';
import { NoteTipList } from './NoteTipList';
import { CommunityNoteCard } from './CommunityNoteCard';

import { Embed, VStack, toElement } from '@oxy.so/bloom-language';

// The scroll's classes as plain objects (inline, as the classes were).
const FILL_STYLE: ViewStyle = { flexGrow: 1, flexShrink: 1, flexBasis: '0%' };
const CONTENT_STYLE: ViewStyle = { gap: 24, paddingInline: 20, paddingBottom: 24 };

interface AboutNoteSheetProps {
  note: CommunityNoteSummary;
  /** Absent until ratings can be sent — the card then shows no rating buttons. */
  onRate?: (rating: CommunityNoteRating) => void;
  onClose: () => void;
}

/** "About this note": how notes get onto posts, and a way in to rating this one. */
export function AboutNoteSheet({ note, onRate, onClose }: AboutNoteSheetProps) {
  const { t } = useTranslation();
  return toElement(
    VStack(
      Embed(
        <NoteSheetHeader
          title={t('communityNotes.about.title', { defaultValue: 'About this note' })}
          onClose={onClose}
        />,
      ),
      Embed(
        <ScrollView style={FILL_STYLE} contentContainerStyle={CONTENT_STYLE}>
          <CommunityNoteCard note={note} variant="rate" onRate={onRate} />
          <NoteTipList
            tips={[
              {
                icon: RiTeamLine,
                title: t('communityNotes.about.writtenTitle', {
                  defaultValue: 'Written by people on Mention',
                }),
                body: t('communityNotes.about.writtenBody', {
                  defaultValue:
                    'Contributors add context to posts that could be misleading. Mention does not write or edit notes.',
                }),
              },
              {
                icon: RiThumbUpLine,
                title: t('communityNotes.about.shownTitle', {
                  defaultValue: 'Shown when different people agree',
                }),
                body: t('communityNotes.about.shownBody', {
                  defaultValue:
                    'A note appears only once people who usually rate differently both find it helpful.',
                }),
              },
              {
                icon: RiEyeOffLine,
                title: t('communityNotes.about.anonymousTitle', { defaultValue: 'Anonymous' }),
                body: t('communityNotes.about.anonymousBody', {
                  defaultValue:
                    'Nobody can see who wrote or rated a note, including the author of the post.',
                }),
              },
            ]}
          />
        </ScrollView>,
      ),
    )
      .background('background')
      .flex('1'),
  );
}
