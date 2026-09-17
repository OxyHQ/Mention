import React, { useCallback } from 'react';
import type { PostPodcastContent } from '@mention/shared-types/post';
import VideoPlayer from '@/components/common/VideoPlayer';
import { openExternalLink } from '@/utils/openExternalLink';
import { PodcastCard } from './PodcastCard';
import { PodcastSaveButton } from './PodcastSaveButton';

interface PostPodcastAttachmentProps {
  podcast: PostPodcastContent;
  width: number;
  /** The shared row height, when the podcast is one of several attachments. */
  height?: number;
}

/**
 * A podcast attached to a post: the card, plus what only a published post has —
 * the save button (the viewer's Syra subscription) and, for an episode with a
 * video rendition, the autoplaying video on top.
 */
export function PostPodcastAttachment({ podcast, width, height }: PostPodcastAttachmentProps) {
  const videoUrl = podcast.episode?.videoUrl;
  const { showUrl } = podcast;
  const openShow = useCallback(() => {
    if (showUrl) openExternalLink(showUrl);
  }, [showUrl]);

  return (
    <PodcastCard
      variant={videoUrl ? 'video' : 'card'}
      title={podcast.title}
      author={podcast.author}
      artworkUrl={podcast.artworkUrl}
      showUrl={showUrl}
      episode={podcast.episode}
      accentColor={podcast.accentColor}
      width={width}
      height={height}
      saveButton={<PodcastSaveButton podcastId={podcast.syraPodcastId} />}
      video={
        videoUrl ? (
          <VideoPlayer
            src={videoUrl}
            poster={podcast.episode?.posterUrl}
            style={{ width: '100%', height: '100%' }}
            contentFit="cover"
            autoPlay
            loop
            onPress={openShow}
          />
        ) : undefined
      }
    />
  );
}
