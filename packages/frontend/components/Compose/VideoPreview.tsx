// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import React from 'react';
import type { StyleProp, ViewStyle } from 'react-native';
import { useVideoPlayer } from 'expo-video';
import { VideoView } from '@oxy.so/bloom/video-view';

interface VideoPreviewProps {
  src: string;
  style?: StyleProp<ViewStyle>;
}

export const VideoPreview: React.FC<VideoPreviewProps> = ({ src, style }) => {
  const player = useVideoPlayer(src, (player) => {
    if (player) {
      player.loop = true;
      player.muted = true;
    }
  });

  React.useEffect(() => {
    if (player) {
      const playVideo = async () => {
        try {
          await player.play();
        } catch {
          // Autoplay may be blocked on web
        }
      };
      playVideo();
    }
    return () => {
      if (player) {
        try {
          player.pause();
        } catch {
          // Silently handle pause errors
        }
      }
    };
  }, [player]);

  return (
    <VideoView
      player={player}
      style={style || { width: '100%', height: '100%' }}
      contentFit="cover"
      nativeControls={false}
      fullscreenOptions={{ enable: false }}
    />
  );
};
