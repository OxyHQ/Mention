import VideoPlayer from '@/components/common/VideoPlayer';
import type { VideoPreview } from './watchVideo';

export type WatchPlaybackSource = Pick<VideoPreview, 'source' | 'fallbackSource' | 'poster'>;

export function WatchPlaybackVideo({
  video,
  onPlaybackStart,
  onSurfacePress,
}: {
  video: WatchPlaybackSource;
  onPlaybackStart?: () => void;
  onSurfacePress?: () => boolean;
}) {
  return (
    <VideoPlayer
      src={video.source}
      fallbackSrc={video.fallbackSource}
      poster={video.poster}
      contentFit="contain"
      controlsLayout="watch"
      onPlaybackStart={onPlaybackStart}
      onSurfacePress={onSurfacePress}
      autoPlay
      style={{ width: '100%', height: '100%' }}
    />
  );
}
