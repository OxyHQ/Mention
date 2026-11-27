import React, { useCallback, useState } from 'react';
import { benchMark } from '@/lib/bench';
import { BloomImage } from '@oxy.so/bloom/image';
import { RiPlayFill } from '@oxy.so/bloom/icons/RiPlayFill';
import { RiFilmLine } from '@oxy.so/bloom/icons/RiFilmLine';
import { formatCompactNumber } from '@/utils/formatNumber';
import { formatDuration } from '@/utils/formatDuration';

import { Embed, HStack, Icon, RawText, VStack, toElement } from '@oxy.so/bloom-language';

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

/**
 * The metadata's text: white at 12/16 semibold under a shadow (black at 80%, 1pt
 * down, 3pt of blur), so it reads over any poster.
 */
const meta = (label: string) =>
  RawText(label)
    .foreground('white')
    .font('xs')
    .leading('16px')
    .weight('semibold')
    .textShadow('0 1px 3px rgb(0 0 0 / 0.8)');

const VideoPosterCell = React.memo<VideoPosterCellProps>(
  ({ posterUri, size, placeholderColor, views, durationSec, scrim }) => {
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

    // One language root for the whole cell: its muted fill, the poster (or the
    // placeholder glyph), the scrim and the metadata row.
    return toElement(
      VStack(
        posterUri && !posterFailed
          ? Embed(
              <BloomImage
                source={{ uri: posterUri }}
                style={{ width: '100%', height: '100%' }}
                contentFit="cover"
                transition={150}
                cachePolicy="memory-disk"
                onLoad={() => benchMark('feed-image')}
                onError={handlePosterError}
              />,
            )
          : VStack(
              Embed(
                <RiFilmLine
                  width={placeholderIconSize}
                  height={placeholderIconSize}
                  fill={placeholderColor}
                />,
              ),
            )
              .frame({ width: 'full', height: 'full' })
              .background('mutedFill')
              .align('center')
              .justify('center'),
        // The scrim: black at 20% over the poster.
        scrim
          ? VStack()
              .position({ top: 'none', right: 'none', bottom: 'none', left: 'none' })
              .background('black/20')
          : null,
        // Both grids wrap this cell in a press, so the row must not swallow the tap
        // along the bottom strip.
        HStack(
          // The play glyph is unconditional: it is the only video marker left after the
          // centered/corner affordances were removed, and an invariant one means the
          // layout never shifts as a cell is recycled onto a post with a different count.
          // It reads as a marker beside its count, so it is sized to the text.
          HStack(
            Icon(RiPlayFill).size('xs').foreground('white'),
            viewsLabel !== null ? meta(viewsLabel) : null,
          )
            .align('center')
            .spacing('2xs'),
          durationLabel !== null ? meta(durationLabel) : null,
        )
          .padding('horizontal', 'xs')
          .padding('bottom', 'xs')
          .align('center')
          .justify('between')
          .spacing('xs')
          .position({ bottom: 'none', left: 'none', right: 'none' })
          .allowsHitTesting(false),
      )
        .frame({ width: size, height: size })
        .background('mutedFill')
        .clipped(),
    );
  },
);
VideoPosterCell.displayName = 'VideoPosterCell';

export default VideoPosterCell;
