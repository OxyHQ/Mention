import type { ReactNode } from 'react';
import { View } from 'react-native';
import { WatchPlaybackVideo } from './WatchPlaybackVideo';
import type { VideoPreview } from './watchVideo';

export interface WatchPlayerSurfaceProps {
  video: VideoPreview;
  focused: boolean;
  dockable: boolean;
  concealed: boolean;
  canContinue: boolean;
  children: ReactNode;
}

export interface WatchPlaybackProviderProps {
  pathname: string;
  children: ReactNode;
}

export interface WatchVideoRailFrameProps {
  postId: string;
  children: ReactNode;
}

export function WatchPlaybackProvider({ children }: WatchPlaybackProviderProps) {
  return children;
}

export function WatchBrowseRail({ children }: { children: ReactNode }) {
  return children;
}

export function WatchPlayerSurface({ video, concealed, children }: WatchPlayerSurfaceProps) {
  return (
    <View className="aspect-video w-full items-center justify-center overflow-hidden rounded-2xl bg-black">
      {concealed ? (
        children
      ) : (
        <WatchPlaybackVideo key={`${video.post.id}:${video.mediaIndex}`} video={video} />
      )}
    </View>
  );
}

export function WatchVideoRailFrame({ children }: WatchVideoRailFrameProps) {
  return <View className="px-4 pb-6 pt-3">{children}</View>;
}
