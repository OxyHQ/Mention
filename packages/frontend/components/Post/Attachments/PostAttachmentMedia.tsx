import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, Text, View, StyleSheet, ViewStyle, Platform } from 'react-native';
import { Image, type ImageLoadEventData } from 'expo-image';
import { BlurView } from 'expo-blur';
import { useTranslation } from 'react-i18next';
import { useTheme } from '@oxy.so/bloom/theme';
import { RiEyeOffLine } from '@oxy.so/bloom/icons/RiEyeOffLine';
import { MediaInsetBorder } from '@oxy.so/bloom/media-inset-border';
import VideoPlayer from '@/components/common/VideoPlayer';
import {
  MEDIA_CARD_WIDTH,
  MEDIA_CARD_HEIGHT,
  MEDIA_CARD_RADIUS,
  SINGLE_MEDIA_MAX_HEIGHT,
} from '@/utils/composeUtils';
import {
  getAspectRatio,
  hasAspectRatio,
  setAspectRatio as setAspectRatioInCache,
  DEFAULT_ASPECT_RATIO,
} from '@oxy.so/bloom/image-aspect-ratio-cache';
import { readMediaAspectRatio } from '@/utils/mediaTypes';
import type { MeasuredRect } from '@oxy.so/bloom/media-flight';
import { useVideoPlayerLease, videoPlayerKey } from '@/stores/videoPlayerRegistry';
import type { VideoPlayer as ExpoVideoPlayer } from 'expo-video';
import { HIT_SLOP_MD } from '@/styles/hitSlop';

/**
 * Registers (or clears, on unmount) the measurable host node of an image
 * thumbnail so the parent row can `measureInWindow` ANY thumbnail by index for
 * the close fly-back. Called with the host `View` on mount and `null` on unmount.
 */
export type RegisterThumbHost = (node: View | null) => void;

const webGrabCursorStyle: ViewStyle | null =
  Platform.OS === 'web' ? ({ cursor: 'grab' } as unknown as ViewStyle) : null;

const MIN_WIDTH = 100;

// A single-media video/gif card needs a DEFINITE height on native: the native
// `VideoView` has no auto-height, so a height-less container lets it overflow
// downward and `overflow:hidden` cannot clip a native child. We fix the width to
// the standard card width and derive the height from the video's real aspect
// ratio (reported by the player once metadata loads), clamped so a very tall
// portrait video cannot run off-screen (excess is letterboxed by contentFit
// "contain"). Web takes the same aspect-derived box: `aspectRatio` maps to the
// CSS property of the same name through react-native-web, and without it the
// <video> is `contentFit: contain`-ed inside whatever box the layout hands it —
// permanently pillarboxed. Web keeps the intrinsic auto-height only until the
// ratio is known, since a height-less <video> there sizes itself and never
// overflows.
const SINGLE_MEDIA_FALLBACK_ASPECT_RATIO = MEDIA_CARD_WIDTH / MEDIA_CARD_HEIGHT;

/**
 * Layout of a media cell, as NativeWind classes. A cell ALONE in the row is as
 * wide as the row and never taller than {@link SINGLE_MEDIA_MAX_HEIGHT}; a cell
 * BESIDE other items takes the row's one height (200, or 264 in a tall row) and
 * is never narrower than a tap target. The classes are literal strings because
 * NativeWind compiles them at build time.
 */
function mediaBoxClass(single: boolean, tallRow: boolean): string {
  if (single) return 'w-full max-h-[420px]';
  return tallRow ? 'self-start h-[264px] min-w-[100px]' : 'self-start h-[200px] min-w-[100px]';
}

/**
 * The one thing no class can hold: this media's own ratio, which arrives with
 * its record. Layout turns it into the missing side — the height of a cell alone
 * in the row, the width of a cell beside others — in the same pass that places
 * it, so the first frame is the final one and nothing is measured.
 *
 * Alone, a square or portrait item that would pass the height cap keeps its
 * ratio by getting NARROWER, not by being cropped: `maxWidth` is the cap times
 * the ratio.
 */
export function mediaBoxStyle(single: boolean, aspectRatio: number): ViewStyle {
  return single
    ? { aspectRatio, maxWidth: Math.max(SINGLE_MEDIA_MAX_HEIGHT * aspectRatio, MIN_WIDTH) }
    : { aspectRatio };
}

/**
 * Sizing for a video/gif card, in BOTH the forms it takes. Learns the video's
 * intrinsic aspect ratio (reported by `<VideoPlayer onAspectRatio>` once
 * metadata loads) and returns the card style plus the `onAspectRatio` handler to
 * feed back.
 *
 * The card must carry a DEFINITE WIDTH in every form, which is the whole reason
 * this covers the non-single case too: a native `VideoView` has no intrinsic
 * size, so a card that sets only a height collapses to ZERO WIDTH and the video
 * disappears — the row hugs a zero-wide child, and `overflow:hidden` cannot clip
 * a native child into existence. Web hides it: there expo-video renders a real
 * HTML `<video>`, a replaced element that carries an intrinsic size of its own,
 * so a width-less box still resolves to something.
 *
 * - Single media: the standard card width, with the height derived from the
 *   ratio and clamped so a very tall portrait video cannot run off-screen
 *   (excess is letterboxed by contentFit "contain"). Until the ratio is known
 *   every platform takes the card ratio's box — never a height-less one, which
 *   collapses to nothing on web.
 * - Beside anything else (another media item, a link preview, a poll, an
 *   article, a quoted post): the standard card HEIGHT with a ratio-derived
 *   width, which is how `PostAttachmentImage` sizes its own box and the height
 *   the row already constrains a neighbouring link card to. Cells in the row
 *   then line up.
 */
function useMediaCardStyle(
  hasSingleMedia: boolean,
  recordAspectRatio?: number,
  tallRow = false,
): {
  cardClass: string;
  cardStyle: ViewStyle;
  onAspectRatio: (ratio: number) => void;
} {
  const [learnedAspectRatio, setLearnedAspectRatio] = useState<number | undefined>(undefined);
  // A ratio carried by the record wins outright: the player reports what its
  // decoder measured on media that was re-encoded to integer pixel dimensions,
  // so the two disagree by a fraction of a percent and adopting the report would
  // resize the card mid-playback. The report is only ever used to LEARN a ratio
  // the record does not carry. (Adapted from bluesky-social/social-app
  // d7f40b7e7, MIT © 2023–2026 Bluesky Social PBC.)
  const hasRecordAspectRatio = recordAspectRatio !== undefined;
  const onAspectRatio = useCallback(
    (ratio: number) => {
      if (hasRecordAspectRatio) return;
      setLearnedAspectRatio((prev) => (prev === ratio ? prev : ratio));
    },
    [hasRecordAspectRatio],
  );
  // Until the ratio is known the card still takes a definite box, the standard
  // card's: a height-less card resolves to ZERO height on web (the player fills
  // 100% of it) and a video with no stored dimensions rendered as nothing.
  const aspectRatio = recordAspectRatio ?? learnedAspectRatio ?? SINGLE_MEDIA_FALLBACK_ASPECT_RATIO;
  return {
    cardClass: mediaBoxClass(hasSingleMedia, tallRow),
    cardStyle: mediaBoxStyle(hasSingleMedia, aspectRatio),
    onAspectRatio,
  };
}

interface PostAttachmentMediaProps {
  type: 'image' | 'video' | 'gif';
  src: string;
  /** Video only: played once if `src` (the adaptive stream) fails to load. */
  fallbackSrc?: string;
  /**
   * Image only: author-authored accessibility description (Bluesky-style "ALT").
   * When present, renders a small "ALT" badge over the image and is used as the
   * image's screen-reader accessibility label.
   */
  alt?: string;
  mediaId?: string;
  /**
   * Id of the post this cell belongs to. Video/GIF cells hand it to the playback
   * authority as their viewability key: on native it is the key the feed list
   * publishes from `onViewableItemsChanged`, so a player only plays while its row
   * is actually viewable.
   */
  postId?: string;
  /** Poster (thumbnail) shown over the video until the first frame plays. */
  poster?: string;
  /** Persisted intrinsic dimensions from the backend DTO (preferred over runtime probing). */
  width?: number;
  height?: number;
  aspectRatio?: number;
  orientation?: 'portrait' | 'landscape' | 'square';
  durationSec?: number;
  /**
   * Video: fired with no args (routes to the reels viewer).
   * Image: fired with the measured on-screen rect of the tapped thumbnail so the
   * gallery can animate the zoom from the image's origin.
   */
  onPress?: (rect?: MeasuredRect) => void;
  hasSingleMedia?: boolean;
  /**
   * The row holds a poll or a video podcast, so every item in it takes the tall
   * row height. Ignored for a cell alone in the row, which takes the full width.
   */
  tallRow?: boolean;
  /**
   * Image only: registers the thumbnail's measurable host node with the parent
   * row's per-index registry so the gallery can fly back to it on dismiss.
   */
  registerHost?: RegisterThumbHost;
  /**
   * When true, this single media cell is gated behind a blurred "Sensitive
   * content — Tap to reveal" cover. The flag is per-post (every media item in a
   * sensitive post receives it), but each cell reveals INDEPENDENTLY: uncovering
   * one image/video never reveals the others.
   */
  sensitive?: boolean;
}

interface PostAttachmentVideoProps {
  src: string;
  fallbackSrc?: string;
  /** Covered by the sensitive-media veil: must not play, and must not be heard. */
  concealed?: boolean;
  poster?: string;
  aspectRatio?: number;
  width?: number;
  height?: number;
  postId?: string;
  mediaId?: string;
  onPress?: () => void;
  hasSingleMedia?: boolean;
  tallRow?: boolean;
  /** Drawn inside the card, over the media (the sensitive-content cover). */
  overlay?: React.ReactNode;
}

/**
 * The card around a feed video, in the two forms it takes.
 *
 * A video that can be opened fullscreen borrows its player from the shared
 * registry and registers itself as a flight anchor, so tapping it hands the
 * SAME decoder to the reels screen instead of starting a second one. A video
 * that cannot — no post id, no media id, so nothing to key an identity on —
 * keeps building its own player exactly as before.
 *
 * They are two components rather than one with a branch because both the lease
 * and the anchor are hooks, and a hook cannot be called conditionally. The
 * shared body below is what they have in common.
 */
const PostAttachmentVideoShell: React.FC<
  PostAttachmentVideoProps & {
    player?: ExpoVideoPlayer;
    flightHostId?: string;
  }
> = ({
  src,
  fallbackSrc,
  concealed,
  poster,
  aspectRatio,
  width,
  height,
  postId,
  onPress,
  hasSingleMedia,
  tallRow,
  overlay,
  player,
  flightHostId,
}) => {
  const recordRatio = readMediaAspectRatio({ aspectRatio, width, height });
  const { cardClass, cardStyle, onAspectRatio } = useMediaCardStyle(
    Boolean(hasSingleMedia),
    recordRatio,
    tallRow,
  );
  return (
    <View
      className={`bg-muted rounded-[15px] overflow-hidden ${cardClass}`}
      style={[webGrabCursorStyle, cardStyle]}
    >
      <VideoPlayer
        src={src}
        fallbackSrc={fallbackSrc}
        concealed={concealed}
        poster={poster}
        style={styles.videoFill}
        contentFit="contain"
        autoPlay={true}
        loop={true}
        onPress={onPress}
        viewabilityKey={postId}
        onAspectRatio={onAspectRatio}
        player={player}
        flightHostId={flightHostId}
      />
      <MediaInsetBorder style={styles.mediaBorder} />
      {overlay}
    </View>
  );
};

/**
 * The flight-capable form. `postId` and `mediaId` are required here, not
 * optional: they ARE the identity the registry and the flight layer agree on,
 * and the caller has already checked for them.
 */
const FlyableVideo: React.FC<PostAttachmentVideoProps & { postId: string; mediaId: string }> = (
  props,
) => {
  const flightId = videoPlayerKey(props.postId, props.mediaId);
  const player = useVideoPlayerLease(flightId, props.src);
  // No `registerAnchor` here: the host registers ITSELF, and registering the
  // card as well would leave two anchors for one id, the outer one measuring a
  // box the media does not fill.
  return <PostAttachmentVideoShell {...props} player={player} flightHostId={flightId} />;
};

const PostAttachmentVideo: React.FC<PostAttachmentVideoProps> = (props) =>
  props.postId && props.mediaId ? (
    <FlyableVideo {...props} postId={props.postId} mediaId={props.mediaId} />
  ) : (
    <PostAttachmentVideoShell {...props} />
  );

// Inline looping muted GIF rendered as an mp4 video (like X/Meta). Mirrors
// PostAttachmentVideo's container/sizing, but with gif semantics: always muted,
// no controls, no mute toggle, and the surface is NOT tappable (no reels/lightbox).
const PostAttachmentGif: React.FC<{
  src: string;
  aspectRatio?: number;
  width?: number;
  height?: number;
  postId?: string;
  hasSingleMedia?: boolean;
  tallRow?: boolean;
  overlay?: React.ReactNode;
}> = ({ src, aspectRatio, width, height, postId, hasSingleMedia, tallRow, overlay }) => {
  const recordRatio = readMediaAspectRatio({ aspectRatio, width, height });
  const { cardClass, cardStyle, onAspectRatio } = useMediaCardStyle(
    Boolean(hasSingleMedia),
    recordRatio,
    tallRow,
  );
  return (
    <View
      className={`bg-muted rounded-[15px] overflow-hidden ${cardClass}`}
      style={[webGrabCursorStyle, cardStyle]}
    >
      <VideoPlayer
        src={src}
        style={styles.videoFill}
        contentFit="contain"
        autoPlay={true}
        loop={true}
        gif={true}
        viewabilityKey={postId}
        onAspectRatio={onAspectRatio}
      />
      <MediaInsetBorder style={styles.mediaBorder} />
      {overlay}
    </View>
  );
};

const FULL_DIMENSION = '100%' as const;

const PostAttachmentImage: React.FC<{
  src: string;
  alt?: string;
  aspectRatio?: number;
  width?: number;
  height?: number;
  onPress?: (rect?: MeasuredRect) => void;
  registerHost?: RegisterThumbHost;
  hasSingleMedia?: boolean;
  tallRow?: boolean;
  overlay?: React.ReactNode;
}> = ({
  src,
  alt,
  aspectRatio: dtoAspectRatio,
  width,
  height,
  onPress,
  registerHost,
  hasSingleMedia,
  tallRow = false,
  overlay,
}) => {
  const theme = useTheme();
  const wrapperRef = useRef<View | null>(null);
  // The ratio is DERIVED while it is knowable synchronously — from the record,
  // else from the shared cache — and only a ratio that has to be measured goes
  // through state. Setting state from an effect for the synchronous cases made
  // the React Compiler skip this component, which every image row mounts
  // (#1103). The measured value is stamped with its `src`, so a recycled row
  // never shows the previous image's shape.
  const recordRatio = readMediaAspectRatio({ aspectRatio: dtoAspectRatio, width, height });
  const cachedRatio = recordRatio === undefined ? getAspectRatio(src) : undefined;
  const [measured, setMeasured] = useState<{ src: string; ratio: number } | null>(null);
  const aspectRatio =
    recordRatio ?? cachedRatio ?? (measured?.src === src ? measured.ratio : undefined);

  // Callback ref: keep the local ref (for open-press measurement) AND mirror the
  // host into the parent's index registry (for the close fly-back). Registers on
  // mount, clears on unmount — no effect needed.
  const setHostRef = useCallback(
    (node: View | null) => {
      wrapperRef.current = node;
      registerHost?.(node);
    },
    [registerHost],
  );

  useEffect(() => {
    if (recordRatio !== undefined) {
      // Persist to the shared cache so the gallery reuses it on open.
      setAspectRatioInCache(src, recordRatio);
    }
  }, [src, recordRatio]);

  // A record without dimensions (old data, some federated media) is measured
  // from the image that loads anyway — `onLoad` carries its intrinsic size —
  // instead of a separate `getSize` request for the same bytes.
  const needsMeasure = recordRatio === undefined && !hasAspectRatio(src);
  const handleImageLoad = useCallback(
    (event: ImageLoadEventData) => {
      if (!needsMeasure) return;
      const { width: naturalWidth, height: naturalHeight } = event.source;
      if (naturalWidth <= 0 || naturalHeight <= 0) return;
      const ratio = naturalWidth / naturalHeight;
      setMeasured({ src, ratio });
      setAspectRatioInCache(src, ratio);
    },
    [needsMeasure, src],
  );
  const handleImageError = useCallback(() => {
    if (!needsMeasure) return;
    setMeasured({ src, ratio: DEFAULT_ASPECT_RATIO });
    setAspectRatioInCache(src, DEFAULT_ASPECT_RATIO);
  }, [needsMeasure, src]);

  const handlePress = useCallback(() => {
    if (!onPress) return;
    const node = wrapperRef.current;
    if (!node) {
      onPress(undefined);
      return;
    }
    node.measureInWindow((x, y, width, height) => {
      onPress({ x, y, width, height });
    });
  }, [onPress]);

  // Sized by layout: `mediaBoxClass` + this image's ratio (see `mediaBoxStyle`).
  const single = Boolean(hasSingleMedia);
  const boxClass = mediaBoxClass(single, tallRow);
  const boxStyle = mediaBoxStyle(single, aspectRatio ?? SINGLE_MEDIA_FALLBACK_ASPECT_RATIO);
  const containerStyles: ViewStyle[] = [
    styles.itemContainer,
    styles.fullSize,
    { backgroundColor: theme.colors.backgroundSecondary },
  ];
  if (webGrabCursorStyle) {
    containerStyles.push(webGrabCursorStyle);
  }

  const hasAlt = typeof alt === 'string' && alt.trim().length > 0;

  // expo-image rather than RN's `Image`: a memory+disk cache that survives
  // relaunches, decoding off the JS thread, and `recyclingKey`, which clears the
  // previous picture the moment FlashList hands this cell to another post
  // instead of showing it until the new one loads. The box behind it carries
  // the muted placeholder colour, so no placeholder element is needed.
  const lazyImage = (
    <View style={containerStyles}>
      <Image
        source={src}
        recyclingKey={src}
        style={styles.fullSize}
        // The box already carries the image's ratio; `cover` only crops where a
        // clamp (the 4:5 floor, MIN_WIDTH, the row width) overrides it.
        contentFit="cover"
        cachePolicy="memory-disk"
        transition={120}
        accessibilityLabel={hasAlt ? alt : undefined}
        accessibilityRole="image"
        onLoad={handleImageLoad}
        onError={handleImageError}
      />
    </View>
  );

  // The media box holds the image plus two non-interactive overlays: the
  // optional "ALT" badge and the hairline inset border that separates the image
  // from the surrounding background (Bluesky-style, replaces a solid 1px border).
  // The outermost element carries the size, so the press target and the rect
  // the gallery flies from are exactly the image — never a wider wrapper.
  const imageContent = (
    <View className={onPress ? undefined : boxClass} style={onPress ? styles.fullSize : boxStyle}>
      {lazyImage}
      {hasAlt && (
        <View
          pointerEvents="none"
          className="absolute bottom-1 left-1 bg-black/60 rounded px-1 py-0.5"
        >
          <Text className="text-white text-[10px] font-bold">ALT</Text>
        </View>
      )}
      <MediaInsetBorder style={styles.mediaBorder} />
      {overlay}
    </View>
  );

  if (!onPress) {
    return imageContent;
  }

  return (
    <Pressable
      ref={setHostRef}
      onPress={handlePress}
      accessibilityRole="imagebutton"
      accessibilityLabel={hasAlt ? alt : 'Open image'}
      collapsable={false}
      className={boxClass}
      style={boxStyle}
    >
      {imageContent}
    </Pressable>
  );
};

const SENSITIVE_BLUR_INTENSITY = 80;

/**
 * Per-item "Sensitive content — Tap to reveal" cover. Rendered ON TOP of the
 * already-painted media so the hidden state is a real blurred preview, not a
 * flat box: on native expo-blur applies a GPU blur (`experimentalBlurMethod`),
 * on web its BlurView fork applies a CSS `backdrop-filter: blur()` over the
 * media behind it. `tint="dark"` adds the dim layer. The whole cover is one
 * Pressable that reveals ONLY its own cell and, while present, intercepts taps
 * so the media's lightbox/reels press handler cannot fire until revealed.
 */
const SensitiveMediaCover: React.FC<{ onReveal: () => void }> = ({ onReveal }) => {
  const { t } = useTranslation();
  return (
    <Pressable
      onPress={onReveal}
      style={styles.sensitiveCover}
      accessibilityRole="button"
      accessibilityLabel={t('post.sensitiveContentTap', { defaultValue: 'Tap to reveal' })}
      hitSlop={HIT_SLOP_MD}
    >
      <BlurView
        intensity={SENSITIVE_BLUR_INTENSITY}
        tint="dark"
        experimentalBlurMethod="dimezisBlurView"
        style={StyleSheet.absoluteFill}
      />
      <View className="items-center gap-1">
        <RiEyeOffLine size="lg" fill="#fff" />
        <Text className="text-white text-[15px] font-semibold">
          {t('post.sensitiveContent', { defaultValue: 'Sensitive content' })}
        </Text>
        <Text className="text-white/60 text-[13px]">
          {t('post.sensitiveContentTap', { defaultValue: 'Tap to reveal' })}
        </Text>
      </View>
    </Pressable>
  );
};

const PostAttachmentMedia: React.FC<PostAttachmentMediaProps> = ({
  type,
  src,
  fallbackSrc,
  alt,
  poster,
  postId,
  mediaId,
  width,
  height,
  aspectRatio,
  onPress,
  hasSingleMedia,
  tallRow,
  registerHost,
  sensitive,
}) => {
  // Per-cell reveal state: each media item owns its own boolean, so revealing
  // one never reveals the rest of the row.
  const [revealed, setRevealed] = useState(false);
  // Drawn INSIDE the media's own box, so the cover is exactly the media's size
  // and no wrapper stands between the box and the row it sizes against. Keeping
  // the media mounted under it means revealing does not remount or reload it —
  // the cover simply unmounts.
  const cover =
    sensitive && !revealed ? <SensitiveMediaCover onReveal={() => setRevealed(true)} /> : null;

  let media: React.ReactNode;
  if (type === 'video') {
    media = (
      <PostAttachmentVideo
        src={src}
        fallbackSrc={fallbackSrc}
        // Kept mounted under the cover (revealing must not reload it), but it
        // must not play, or be heard, behind it.
        concealed={Boolean(sensitive) && !revealed}
        poster={poster}
        mediaId={mediaId}
        width={width}
        height={height}
        aspectRatio={aspectRatio}
        postId={postId}
        onPress={onPress}
        hasSingleMedia={hasSingleMedia}
        tallRow={tallRow}
        overlay={cover}
      />
    );
  } else if (type === 'gif') {
    media = (
      <PostAttachmentGif
        src={src}
        width={width}
        height={height}
        aspectRatio={aspectRatio}
        postId={postId}
        hasSingleMedia={hasSingleMedia}
        tallRow={tallRow}
        overlay={cover}
      />
    );
  } else {
    media = (
      <PostAttachmentImage
        src={src}
        alt={alt}
        width={width}
        height={height}
        aspectRatio={aspectRatio}
        onPress={onPress}
        registerHost={registerHost}
        hasSingleMedia={hasSingleMedia}
        tallRow={tallRow}
        overlay={cover}
      />
    );
  }

  return media;
};

const styles = StyleSheet.create({
  itemContainer: {
    borderRadius: MEDIA_CARD_RADIUS,
    overflow: 'hidden',
  },
  // Corner radius for the inset hairline so it tracks the media box's rounding.
  mediaBorder: {
    borderRadius: MEDIA_CARD_RADIUS,
  },
  fullSize: {
    width: FULL_DIMENSION,
    height: FULL_DIMENSION,
  },
  // Fills the single-media card, which owns the definite (aspect-derived) box on
  // both platforms once the ratio is known, and a fixed width with intrinsic
  // auto-height on web before that.
  videoFill: {
    width: FULL_DIMENSION,
    height: FULL_DIMENSION,
  },
  // Hugs the media's intrinsic size in the horizontal row so the absolute cover
  // matches the cell exactly.
  sensitiveCover: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 10,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: MEDIA_CARD_RADIUS,
    overflow: 'hidden',
  },
});

// One per media cell in a feed row. Memoized so it (and the VideoPlayer it mounts)
// skips re-rendering when the attachments row re-renders without this cell's props
// changing — effective because PostAttachmentsRow now passes a stable per-media
// `onPress` and the rest of the props are primitives/stable refs.
export default React.memo(PostAttachmentMedia);
