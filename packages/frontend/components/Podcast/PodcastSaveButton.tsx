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
      style={({ pressed }) => ({
        width: 30,
        height: 30,
        borderRadius: 15,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: pressed ? 'rgba(255,255,255,0.32)' : 'rgba(255,255,255,0.2)',
      })}
    >
      {isSaved ? <BookmarkActive size={15} color="white" /> : <Bookmark size={15} color="white" />}
    </Pressable>
  );
};
