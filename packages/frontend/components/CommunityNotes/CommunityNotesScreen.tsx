import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Screen } from '@oxy.so/bloom/screen';
import type { TFunction } from 'i18next';
import type {
  CommunityNoteRating,
  CommunityNoteStatus,
  CommunityNoteSummary,
  HydratedPostSummary,
} from '@mention/shared-types';
import { EmptyState } from '@/components/common/EmptyState';
import PostItem from '@/components/Feed/PostItem';
import { useOpenPostEngagement } from '@/components/Post/postEngagementContext';
import { CommunityNoteCard } from './CommunityNoteCard';
import { useCommunityNoteSheets, type CommunityNoteWriteHandlers } from './useCommunityNoteSheets';

import {
  Embed,
  Header,
  RawText,
  ScrollView,
  TabItem,
  Tabs as LTabs,
  VStack,
  toElement,
} from '@oxy.so/bloom-language';

/** A note together with the post it is about. */
export interface CommunityNoteEntry {
  post: HydratedPostSummary;
  note: CommunityNoteSummary;
}

type TabId = 'rate' | 'ratings' | 'notes';

/**
 * What became of a note the viewer wrote.
 *
 * All four of CrowdSource's statuses are named, including the two a reader never
 * sees. A writer whose note was rated unhelpful is told so plainly: the status
 * is an outcome of how it was rated, not a judgement of them, and leaving them
 * to guess from a note that simply never appears would be worse.
 */
function statusLabel(status: CommunityNoteStatus, t: TFunction): string {
  switch (status) {
    case 'shown':
      return t('communityNotes.hub.statusShown', { defaultValue: 'Shown on the post' });
    case 'not_shown':
      return t('communityNotes.hub.statusNotShown', {
        defaultValue: 'Not shown — raters did not find it helpful',
      });
    case 'withdrawn':
      return t('communityNotes.hub.statusWithdrawn', { defaultValue: 'You took this note back' });
    default:
      return t('communityNotes.hub.statusNeedsRatings', { defaultValue: 'Needs more ratings' });
  }
}

interface CommunityNotesScreenProps {
  /** Notes waiting for this reader's rating. */
  toRate: CommunityNoteEntry[];
  /** Notes this reader rated. */
  rated: CommunityNoteEntry[];
  /** Notes this reader wrote. */
  written: CommunityNoteEntry[];
  handlers?: CommunityNoteWriteHandlers;
}

/**
 * The community-notes hub: rate notes, your ratings, your notes. Data comes from
 * the caller — CrowdSource owns every list here.
 */
export function CommunityNotesScreen({
  toRate,
  rated,
  written,
  handlers,
}: CommunityNotesScreenProps) {
  const { t } = useTranslation();
  const openPostEngagement = useOpenPostEngagement();
  const [tab, setTab] = useState<TabId>('rate');
  // Ratings made on this screen, so a rated note moves out of the queue at once.
  const [localRatings, setLocalRatings] = useState<Record<string, CommunityNoteRating>>({});
  const sheets = useCommunityNoteSheets(handlers);

  const withLocal = (entry: CommunityNoteEntry): CommunityNoteEntry =>
    localRatings[entry.note.id]
      ? { ...entry, note: { ...entry.note, viewerRating: localRatings[entry.note.id] } }
      : entry;

  const queue = toRate.map(withLocal).filter((entry) => !entry.note.viewerRating);
  const ratedNow = toRate.map(withLocal).filter((entry) => entry.note.viewerRating);
  const entries = tab === 'rate' ? queue : tab === 'ratings' ? [...ratedNow, ...rated] : written;

  const intro = {
    rate: t('communityNotes.hub.rateIntro', {
      defaultValue:
        'Decide if the community notes on these posts are helpful. Ratings are anonymous.',
    }),
    ratings: t('communityNotes.hub.ratingsIntro', {
      defaultValue: "Notes you've rated. Ratings can't be changed.",
    }),
    notes: t('communityNotes.hub.notesIntro', {
      defaultValue: "Notes you've written, and whether they are shown yet.",
    }),
  }[tab];

  const empty = {
    rate: t('communityNotes.hub.rateEmpty', {
      defaultValue: 'No notes need your rating right now',
    }),
    ratings: t('communityNotes.hub.ratingsEmpty', {
      defaultValue: "You haven't rated any notes yet",
    }),
    notes: t('communityNotes.hub.notesEmpty', {
      defaultValue: "You haven't written any notes yet",
    }),
  }[tab];

  return (
    <Screen
      header={toElement(
        Header(t('communityNotes.hub.title', { defaultValue: 'Community notes' }))
          .backLabel(t('common.back', { defaultValue: 'Back' }))
          .accessory(
            LTabs(
              [tab, (id) => setTab(id as TabId)],
              [
                {
                  id: 'rate',
                  label: t('communityNotes.hub.tabRate', { defaultValue: 'Rate notes' }),
                },
                {
                  id: 'ratings',
                  label: t('communityNotes.hub.tabRatings', { defaultValue: 'Your ratings' }),
                },
                {
                  id: 'notes',
                  label: t('communityNotes.hub.tabNotes', { defaultValue: 'Your notes' }),
                },
              ].map((tab: { id: string; label: string; count?: number }) =>
                TabItem(tab.id, tab.label).count(tab.count),
              ),
            ).style('underline'),
          )
          .inPage(),
      )}
    >
      {toElement(
        ScrollView(
          RawText(intro)
            .padding('horizontal', 'lg')
            .foreground('foreground')
            .font('md')
            .leading('20px'),
          Embed(
            entries.length === 0 ? (
              <EmptyState title={empty} sticker="communityNotes" />
            ) : (
              entries.map(({ post, note }) =>
                toElement(
                  VStack(
                    VStack(
                      Embed(
                        <PostItem post={post} isNested openPostEngagement={openPostEngagement} />,
                      ),
                    ).padding('horizontal', 'lg'),
                    VStack(
                      Embed(
                        <CommunityNoteCard
                          note={note}
                          variant="rate"
                          onRate={
                            tab === 'notes' || !sheets.canRate
                              ? undefined
                              : (rating) =>
                                  sheets.openRateReasons(note, rating, (done) =>
                                    setLocalRatings((current) => ({ ...current, [note.id]: done })),
                                  )
                          }
                        />,
                      ),
                      tab === 'notes'
                        ? RawText(statusLabel(note.status, t))
                            .foreground('muted')
                            .margin('top', 'sm')
                            .font('sm')
                        : null,
                    ).padding('horizontal', 'lg'),
                  )
                    .padding('bottom', '2xl')
                    .border('border', 'thin', 'bottom')
                    .spacing('md'),
                  note.id,
                ),
              )
            ),
          ),
        ).contentView((v) => v.padding('bottom', '4xl').padding('top', 'lg').spacing('2xl')),
      )}
    </Screen>
  );
}
