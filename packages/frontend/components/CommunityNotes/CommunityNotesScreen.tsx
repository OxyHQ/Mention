import React, { useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '@oxy.so/bloom/page-header';
import type { CommunityNoteRating, CommunityNoteSummary, HydratedPostSummary } from '@mention/shared-types';
import AnimatedTabBar from '@/components/common/AnimatedTabBar';
import { EmptyState } from '@/components/common/EmptyState';
import PostItem from '@/components/Feed/PostItem';
import { useSafeBack } from '@/hooks/useSafeBack';
import { CommunityNoteCard } from './CommunityNoteCard';
import { useCommunityNoteSheets, type CommunityNoteWriteHandlers } from './useCommunityNoteSheets';

/** A note together with the post it is about. */
export interface CommunityNoteEntry {
  post: HydratedPostSummary;
  note: CommunityNoteSummary;
}

type TabId = 'rate' | 'ratings' | 'notes';

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
export function CommunityNotesScreen({ toRate, rated, written, handlers }: CommunityNotesScreenProps) {
  const { t } = useTranslation();
  const safeBack = useSafeBack();
  const [tab, setTab] = useState<TabId>('rate');
  // Ratings made on this screen, so a rated note moves out of the queue at once.
  const [localRatings, setLocalRatings] = useState<Record<string, CommunityNoteRating>>({});
  const sheets = useCommunityNoteSheets(handlers);

  const withLocal = (entry: CommunityNoteEntry): CommunityNoteEntry =>
    localRatings[entry.note.id] ? { ...entry, note: { ...entry.note, viewerRating: localRatings[entry.note.id] } } : entry;

  const queue = toRate.map(withLocal).filter((entry) => !entry.note.viewerRating);
  const ratedNow = toRate.map(withLocal).filter((entry) => entry.note.viewerRating);
  const entries = tab === 'rate' ? queue : tab === 'ratings' ? [...ratedNow, ...rated] : written;

  const intro = {
    rate: t('communityNotes.hub.rateIntro', { defaultValue: 'Decide if the community notes on these posts are helpful. Ratings are anonymous.' }),
    ratings: t('communityNotes.hub.ratingsIntro', { defaultValue: "Notes you've rated. Ratings can't be changed." }),
    notes: t('communityNotes.hub.notesIntro', { defaultValue: "Notes you've written, and whether they are shown yet." }),
  }[tab];

  const empty = {
    rate: t('communityNotes.hub.rateEmpty', { defaultValue: 'No notes need your rating right now' }),
    ratings: t('communityNotes.hub.ratingsEmpty', { defaultValue: "You haven't rated any notes yet" }),
    notes: t('communityNotes.hub.notesEmpty', { defaultValue: "You haven't written any notes yet" }),
  }[tab];

  return (
    <View className="flex-1">
      <PageHeader
        title={t('communityNotes.hub.title', { defaultValue: 'Community notes' })}
        onBack={() => safeBack()}
        backLabel={t('common.back', { defaultValue: 'Back' })}
      />
      <AnimatedTabBar
        instanceId="community-notes"
        activeTabId={tab}
        onTabPress={(id) => setTab(id as TabId)}
        tabs={[
          { id: 'rate', label: t('communityNotes.hub.tabRate', { defaultValue: 'Rate notes' }) },
          { id: 'ratings', label: t('communityNotes.hub.tabRatings', { defaultValue: 'Your ratings' }) },
          { id: 'notes', label: t('communityNotes.hub.tabNotes', { defaultValue: 'Your notes' }) },
        ]}
      />
      <ScrollView className="flex-1" contentContainerClassName="gap-6 pb-10 pt-4">
        <Text className="text-foreground px-4 text-[15px] leading-5">{intro}</Text>
        {entries.length === 0 ? (
          <EmptyState title={empty} icon={{ name: 'people-outline', size: 44 }} />
        ) : (
          entries.map(({ post, note }) => (
            <View key={note.id} className="border-border gap-3 border-b pb-6">
              <View className="px-4">
                <PostItem post={post} isNested />
              </View>
              <View className="px-4">
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
                />
                {tab === 'notes' ? (
                  <Text className="text-muted-foreground mt-2 text-[13px]">
                    {note.status === 'shown'
                      ? t('communityNotes.hub.statusShown', { defaultValue: 'Shown on the post' })
                      : t('communityNotes.hub.statusNeedsRatings', { defaultValue: 'Needs more ratings' })}
                  </Text>
                ) : null}
              </View>
            </View>
          ))
        )}
      </ScrollView>
    </View>
  );
}
