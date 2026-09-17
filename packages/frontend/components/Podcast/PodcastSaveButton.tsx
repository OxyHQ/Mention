import React from 'react';
import { Pressable } from 'react-native';
import { useTranslation } from 'react-i18next';
import { HIT_SLOP_MD } from '@/styles/hitSlop';
import { Bookmark, BookmarkActive } from '@/assets/icons/bookmark-icon';
import { usePodcastSave } from '@/hooks/usePodcastSave';

/**
 * The podcast card's save button: subscribes the viewer to the show in their
 * Syra library. Its own component so the subscription query only mounts where
 * a save button is actually shown.
 */
export const PodcastSaveButton = ({ podcastId }: { podcastId: string }) => {
  const { t } = useTranslation();
  const { isSaved, toggleSave } = usePodcastSave(podcastId);
  const label = isSaved
    ? t('podcast.card.unsave', { defaultValue: 'Remove from saved' })
    : t('podcast.card.save', { defaultValue: 'Save' });
  return (
    <Pressable
      onPress={toggleSave}
      hitSlop={HIT_SLOP_MD}
      accessibilityRole="button"
      accessibilityState={{ selected: isSaved }}
      accessibilityLabel={label}
      className="size-[30px] rounded-full items-center justify-center bg-white/20 active:bg-white/30"
    >
      {isSaved ? <BookmarkActive size={15} color="white" /> : <Bookmark size={15} color="white" />}
    </Pressable>
  );
};
