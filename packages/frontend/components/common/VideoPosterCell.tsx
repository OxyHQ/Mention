import React, { useCallback, useMemo, useState } from 'react';
import { Text, View, type TextStyle } from 'react-native';
import { Image } from 'expo-image';
import Ionicons from '@expo/vector-icons/Ionicons';
import { formatCompactNumber } from '@/utils/formatNumber';
import { formatDuration } from '@/utils/formatDuration';

interface VideoPosterCellProps {
  /**
   * Static poster URL: an Oxy `thumb` variant for native assets, or the backend
   * `/media/poster` frame for federated videos. Undefined → icon placeholder.
   */
  posterUri?: string;
  size: number;
  placeholderColor: string;
  /**
   * Play count for the post this cell's media belongs to.
   *
   * PER-POST, not per-media: two videos in one post carry the same number, the
   * same way the media grid's carousel chip paints on every one of a post's
   * cells. Absent or zero means genuinely zero — `views` carries no privacy gate
   * on the way out of hydration, unlike likes/boosts/replies/saves — so the
   * count is simply omitted rather than shown as `0`.
   *
   * The type is deliberately `number | null | undefined`: a zero-view post
   * arrives as `null` from the API and web's in-memory store, but as `0` after
   * the native SQLite round-trip (`views_count` is a numeric column, and
   * `0 ?? null` is `0`). Both must render identically.
   */
  views?: number | null;
  /** Duration of THIS cell's video, in seconds. Per-item, so per-cell correct. */
  durationSec?: number;
  /**
   * Darken the poster behind the metadata row. The media grid mixes videos with
   * photos and needs the contrast; an all-video grid would only be dimming
   * itself uniformly for no signal.
   */
  scrim?: boolean;
}

// Placeholder video icon size, per grid density (matches each grid's original).
const SCRIM_PLACEHOLDER_ICON_SIZE = 32;
const PLAIN_PLACEHOLDER_ICON_SIZE = 24;

// Metadata row: the play glyph reads as a marker beside its count, so it is
// sized to the text rather than to a tappable target.
const META_PLAY_ICON_SIZE = 12;

// Translucent overlay/scrim colors — functional alpha layers over the poster,
// not theme/brand colors, so they live here as named constants.
const SCRIM_BG = 'rgba(0, 0, 0, 0.2)';
const META_TEXT_COLOR = 'white';

/**
 * Legibility over an arbitrary poster frame, without a per-cell gradient view or
 * a pill that would eat a third of the width of a ~120px cell. Same values as
 * the reels screen uses over moving video; redeclared rather than imported,
 * because that module is a ROUTE and `components/common/` must not depend on
 * one. `Ionicons` is a `Text`-based glyph font, so the glyph takes the shadow
 * exactly like the number does.
 */
const META_TEXT_SHADOW: Pick<TextStyle, 'textShadowColor' | 'textShadowOffset' | 'textShadowRadius'> = {
  textShadowColor: 'rgba(0, 0, 0, 0.8)',
  textShadowOffset: { width: 0, height: 1 },
  textShadowRadius: 3,
};

/**
 * A single static video grid cell: a paused poster image (no live decoder), a
 * play count and a duration — playback happens only in the fullscreen reels
 * screen on tap. Shared by the profile media + videos grids; `scrim` selects
 * whether the poster is darkened behind the metadata. Memoized so cells never
 * remount on parent re-render.
 *
 * The metadata row lives here rather than beside each grid's `renderCell` so the
 * two grids cannot drift apart pixel-wise, and so its z-order against the media
 * grid's carousel chip is defined in one place.
 *
 * The poster (especially the federated `/media/poster` frame) can 404 / fail to
 * load → falls back to the video-icon placeholder, never a broken image.
 */
const VideoPosterCell = React.memo<VideoPosterCellProps>(
  ({ posterUri, size, placeholderColor, views, durationSec, scrim }) => {
    const containerStyle = useMemo(
      () => ({ width: size, height: size, overflow: 'hidden' as const }),
      [size]
    );
    const [posterFailed, setPosterFailed] = useState(false);
    // A new poster has not failed yet. Reset during render rather than in an
    // effect, so a new URI never renders one committed frame of the previous
    // one's placeholder.
    const [failedUri, setFailedUri] = useState(posterUri);
    if (failedUri !== posterUri) {
      setFailedUri(posterUri);
      setPosterFailed(false);
    }

    const handlePosterError = useCallback(() => setPosterFailed(true), []);

    const placeholderIconSize = scrim ? SCRIM_PLACEHOLDER_ICON_SIZE : PLAIN_PLACEHOLDER_ICON_SIZE;
    // Both guards are on the VALUE, not on its absence. A zero count is not
    // information and the two platforms disagree on how they spell it (see the
    // `views` prop); a zero duration would render `0:00`, which claims a length
    // the clip does not have. Callers today read duration through
    // `readMediaDurationSec`, which already rejects `<= 0` — but the component
    // owns its own contract, and the next caller will not know that.
    const viewsLabel = typeof views === 'number' && views > 0 ? formatCompactNumber(views) : null;
    const durationLabel =
      typeof durationSec === 'number' && durationSec > 0 ? formatDuration(durationSec) : null;

    return (
      <View className="bg-secondary" style={containerStyle}>
        {posterUri && !posterFailed ? (
          <Image
            source={{ uri: posterUri }}
            style={{ width: '100%', height: '100%' }}
            contentFit="cover"
            transition={150}
            cachePolicy="memory-disk"
            onError={handlePosterError}
          />
        ) : (
          <View className="w-full h-full items-center justify-center bg-secondary">
            <Ionicons name="videocam-outline" size={placeholderIconSize} color={placeholderColor} />
          </View>
        )}
        {scrim && (
          <View className="absolute inset-0" style={{ backgroundColor: SCRIM_BG }} />
        )}
        {/*
          Both grids wrap this cell in a TouchableOpacity, so the row must not
          swallow the tap along the bottom strip.
        */}
        <View
          className="absolute bottom-0 left-0 right-0 flex-row items-center justify-between px-1 pb-1 gap-1"
          pointerEvents="none"
        >
          {/*
            The play glyph is unconditional: it is the only video marker left
            after the centered/corner affordances were removed, and an invariant
            one means the layout never shifts as a cell is recycled onto a post
            with a different count.
          */}
          <View className="flex-row items-center gap-0.5">
            <Ionicons
              name="play"
              size={META_PLAY_ICON_SIZE}
              color={META_TEXT_COLOR}
              style={META_TEXT_SHADOW}
            />
            {viewsLabel !== null && (
              <Text className="text-white text-xs font-semibold" style={META_TEXT_SHADOW}>
                {viewsLabel}
              </Text>
            )}
          </View>
          {durationLabel !== null && (
            <Text className="text-white text-xs font-semibold" style={META_TEXT_SHADOW}>
              {durationLabel}
            </Text>
          )}
        </View>
      </View>
    );
  }
);
VideoPosterCell.displayName = 'VideoPosterCell';

export default VideoPosterCell;
