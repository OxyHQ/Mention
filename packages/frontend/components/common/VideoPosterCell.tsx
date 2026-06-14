import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { View } from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';

/**
 * Where the play affordance sits on the cell:
 *  - `center`: a translucent full-cell scrim with a centered `play-circle`
 *    (used by the profile media grid).
 *  - `corner`: a small rounded chip in the top-right with a `play` glyph
 *    (used by the profile videos grid).
 */
export type VideoPosterBadge = 'center' | 'corner';

interface VideoPosterCellProps {
  /**
   * Static poster URL: an Oxy `thumb` variant for native assets, or the backend
   * `/media/poster` frame for federated videos. Undefined → icon placeholder.
   */
  posterUri?: string;
  size: number;
  placeholderColor: string;
  badge: VideoPosterBadge;
}

// Corner chip (videos grid) dimensions.
const CORNER_BADGE_SIZE = 24;
const CORNER_BADGE_RADIUS = 12;
const CORNER_PLAY_ICON_SIZE = 16;

// Center badge (media grid) icon size.
const CENTER_PLAY_ICON_SIZE = 24;

// Placeholder video icon size, per badge variant (matches each grid's original).
const CORNER_PLACEHOLDER_ICON_SIZE = 24;
const CENTER_PLACEHOLDER_ICON_SIZE = 32;

// Translucent overlay/scrim colors — functional alpha layers over the poster,
// not theme/brand colors, so they live here as named constants.
const CORNER_BADGE_BG = 'rgba(0, 0, 0, 0.6)';
const CENTER_SCRIM_BG = 'rgba(0, 0, 0, 0.2)';
const PLAY_GLYPH_COLOR = 'white';
const CENTER_PLAY_GLYPH_COLOR = 'rgba(255, 255, 255, 0.9)';

/**
 * A single static video grid cell: a paused poster image (no live decoder) plus
 * a play affordance — playback happens only in the fullscreen reels screen on
 * tap. Shared by the profile media + videos grids; the `badge` prop selects the
 * center scrim vs. the top-right chip. Memoized so cells never remount on parent
 * re-render.
 *
 * The poster (especially the federated `/media/poster` frame) can 404 / fail to
 * load → falls back to the video-icon placeholder, never a broken image.
 */
const VideoPosterCell = React.memo<VideoPosterCellProps>(
  ({ posterUri, size, placeholderColor, badge }) => {
    const containerStyle = useMemo(
      () => ({ width: size, height: size, overflow: 'hidden' as const }),
      [size]
    );
    const [posterFailed, setPosterFailed] = useState(false);

    useEffect(() => {
      setPosterFailed(false);
    }, [posterUri]);

    const handlePosterError = useCallback(() => setPosterFailed(true), []);

    const placeholderIconSize =
      badge === 'corner' ? CORNER_PLACEHOLDER_ICON_SIZE : CENTER_PLACEHOLDER_ICON_SIZE;

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
        {badge === 'corner' ? (
          <View
            className="absolute top-1 right-1 items-center justify-center"
            style={{
              backgroundColor: CORNER_BADGE_BG,
              borderRadius: CORNER_BADGE_RADIUS,
              width: CORNER_BADGE_SIZE,
              height: CORNER_BADGE_SIZE,
            }}
          >
            <Ionicons name="play" size={CORNER_PLAY_ICON_SIZE} color={PLAY_GLYPH_COLOR} />
          </View>
        ) : (
          <View
            className="absolute inset-0 items-center justify-center"
            style={{ backgroundColor: CENTER_SCRIM_BG }}
          >
            <Ionicons name="play-circle" size={CENTER_PLAY_ICON_SIZE} color={CENTER_PLAY_GLYPH_COLOR} />
          </View>
        )}
      </View>
    );
  }
);
VideoPosterCell.displayName = 'VideoPosterCell';

export default VideoPosterCell;
