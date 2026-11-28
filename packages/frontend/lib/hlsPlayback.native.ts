// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import type { VideoPlayer } from 'expo-video';
import { useCallback } from 'react';
import type { VideoViewHandle } from '@oxy.so/bloom/video-view';

/**
 * HLS playback on native: nothing to do.
 *
 * ExoPlayer (Android) and AVPlayer (iOS) both decode HLS natively, and
 * `expo-video` hands the playlist url straight to them. Shipping a JS demuxer
 * here would replace a hardware decoder with a software one — so this side of
 * the split is deliberately inert, and `active` is always false, meaning the
 * caller keeps giving the source to `expo-video`.
 *
 * The web counterpart, and why it exists at all, is in `hlsPlayback.web.ts`.
 */

/** What the caller needs to know about the JS decoder for one source. */
export interface HlsPlayback {
  /** Always false on native — the platform decoder owns HLS. */
  readonly active: boolean;
  /** The stable attachment callback, filling the caller's view ref. */
  readonly ref: React.RefCallback<VideoViewHandle>;
}

/** Never on native: the platform decoder plays HLS itself. */
export function needsJsHlsDecoder(_src: string | undefined | null): boolean {
  return false;
}

export function useHlsPlayback(
  _src: string,
  viewRef: React.RefObject<VideoViewHandle | null>,
  _player: VideoPlayer,
  _fallbackSrc?: string,
): HlsPlayback {
  const ref = useCallback(
    (handle: VideoViewHandle | null) => {
      viewRef.current = handle;
    },
    [viewRef],
  );
  return { active: false, ref };
}
