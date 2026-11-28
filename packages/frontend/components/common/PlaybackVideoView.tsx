import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { VideoPlayer, VideoViewProps } from 'expo-video';
import { VideoView, type VideoViewHandle } from '@oxy.so/bloom/video-view';
import { needsJsHlsDecoder, useHlsPlayback } from '@/lib/hlsPlayback';
import { setVideoHasRenderedFrame } from '@oxy.so/bloom/video-playback';

import { acquireVideoPlayer, type VideoPlayerKey } from '@/stores/videoPlayerRegistry';
import { videoSourceFor } from '@/utils/videoSource';
import { createLogger } from '@oxy.so/core/logger';

const logger = createLogger('PlaybackVideoView');

interface PlaybackVideoViewProps extends Omit<VideoViewProps, 'player'> {
  player: VideoPlayer;
  source: string;
  registryKey?: VideoPlayerKey;
  fallbackSource?: string;
  detached?: boolean;
  onSourceError?: () => void;
}

/**
 * The decoder belongs to the video element. Both feed and reel render this
 * component in Bloom's persistent media node, so handing the node to another
 * presenter changes its controls/ref without destroying HLS or its buffer.
 */
export const PlaybackVideoView = forwardRef<VideoViewHandle | null, PlaybackVideoViewProps>(
  function PlaybackVideoView(
    {
      player,
      source,
      registryKey,
      fallbackSource,
      detached,
      onFirstFrameRender,
      onSourceError,
      ...props
    },
    forwardedRef,
  ) {
    const viewRef = useRef<VideoViewHandle | null>(null);
    // A persistent flight view can outlive both route presenters. Its lease
    // keeps the shared player alive until the actual view has unmounted.
    const initialSource = useRef(source);
    useEffect(() => {
      if (!registryKey) return;
      const lease = acquireVideoPlayer(registryKey, initialSource.current);
      return lease.release;
    }, [registryKey, player]);
    // Initial players are constructed with this source (or null for JS HLS).
    // Later changes first detach the old decoder, then replace the player's
    // source, and only then attach a new decoder. In particular, an MP4 left
    // on the player must not overwrite HLS's blob URL on the next render.
    const [sourceState, setSourceState] = useState<{
      player: VideoPlayer;
      requested: string;
      loaded: string | null;
    }>({ player, requested: source, loaded: source });
    if (sourceState.player !== player || sourceState.requested !== source) {
      setSourceState({ player, requested: source, loaded: null });
    }
    const decoderSource =
      sourceState.player === player && sourceState.loaded === source ? source : '';
    const { ref: hlsRef } = useHlsPlayback(decoderSource, viewRef, player, fallbackSource);
    const requestedSource = useRef({ player, source });
    const replacement = useRef<Promise<void>>(Promise.resolve());
    const sourceErrorRef = useRef(onSourceError);
    useEffect(() => {
      sourceErrorRef.current = onSourceError;
    }, [onSourceError]);
    useEffect(() => {
      if (requestedSource.current.player === player && requestedSource.current.source === source)
        return;
      requestedSource.current = { player, source };
      let cancelled = false;
      // Native replacements are asynchronous and cannot be cancelled once they
      // start. Serialize them so a late B cannot overwrite a newer request for A.
      replacement.current = replacement.current
        .then(async () => {
          if (cancelled) return;
          setVideoHasRenderedFrame(player, false);
          await player.replaceAsync(needsJsHlsDecoder(source) ? null : videoSourceFor(source));
          if (!cancelled) setSourceState({ player, requested: source, loaded: source });
        })
        .catch((error: unknown) => {
          if (cancelled) return;
          logger.error('Video source replacement failed', error);
          sourceErrorRef.current?.();
        });
      return () => {
        cancelled = true;
      };
    }, [player, source]);
    const handleFirstFrame = useCallback(() => {
      setVideoHasRenderedFrame(player, true);
      onFirstFrameRender?.();
    }, [player, onFirstFrameRender]);
    useImperativeHandle<VideoViewHandle | null, VideoViewHandle | null>(
      forwardedRef,
      () => viewRef.current,
    );
    return (
      <VideoView
        {...props}
        player={detached ? null : player}
        ref={hlsRef}
        onFirstFrameRender={handleFirstFrame}
      />
    );
  },
);
