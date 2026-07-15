import React, { memo, useCallback, useContext } from 'react';
import type { ProfileMedia as ProfileMediaData } from '@/store/appearanceStore';
import { BottomSheetContext } from '@/context/BottomSheetContext';
import { ProfileSong } from './ProfileSong';
import { PodcastCard } from '@/components/Podcast/PodcastCard';
import { MediaPickerSheet } from './MediaPickerSheet';

interface ProfileMediaProps {
  media: ProfileMediaData | null;
  isOwnProfile: boolean;
}

/**
 * Dispatcher for a profile's pinned media (song XOR podcast). Renders the
 * compact song row for `type === 'song'`, the Threads-style card for
 * `type === 'podcast'`, and nothing when no media is pinned or for other
 * viewers. Owns the shared picker-open callback so the song edit affordance
 * and the podcast edit affordance both open the same `MediaPickerSheet`.
 * Management of pinned media (adding when nothing is set) lives on the Edit
 * Profile screen (`PinnedMediaSection`), not inline on the public profile.
 *
 * `ProfileContent` gates WHERE this mounts (the song entry after the stats,
 * the podcast card at the bottom of the header), so this component only ever
 * renders its single matching branch.
 */
export const ProfileMedia = memo(function ProfileMedia({ media, isOwnProfile }: ProfileMediaProps) {
  const bottomSheet = useContext(BottomSheetContext);

  const openPicker = useCallback(() => {
    bottomSheet.setBottomSheetContent(
      <MediaPickerSheet
        currentMedia={media}
        onClose={() => bottomSheet.openBottomSheet(false)}
      />,
    );
    bottomSheet.openBottomSheet(true);
  }, [bottomSheet, media]);

  if (!media) {
    // Nothing pinned: management now lives on the Edit Profile screen
    // (`PinnedMediaSection`), not inline on the public profile.
    return null;
  }

  if (media.type === 'song') {
    return <ProfileSong song={media} isOwnProfile={isOwnProfile} onEdit={openPicker} />;
  }

  return (
    <PodcastCard
      variant="full"
      title={media.title}
      author={media.author}
      artworkUrl={media.artworkUrl}
      showUrl={media.showUrl}
      isOwnProfile={isOwnProfile}
      onEdit={openPicker}
    />
  );
});
