import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Image, Pressable, Text, View, StyleSheet, ViewStyle, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { BlurView } from 'expo-blur';
import { useTranslation } from 'react-i18next';
import { useTheme } from '@oxyhq/bloom/theme';
import { LazyImage } from '@/components/ui/LazyImage';
import VideoPlayer from '@/components/common/VideoPlayer';
import { MEDIA_CARD_WIDTH, MEDIA_CARD_HEIGHT, MEDIA_CARD_RADIUS } from '@/utils/composeUtils';
import {
  getAspectRatio,
  hasAspectRatio,
  setAspectRatio as setAspectRatioInCache,
  DEFAULT_ASPECT_RATIO,
} from '@/utils/imageAspectRatioCache';

/** Screen-space rectangle of a tapped thumbnail, used to seed the zoom origin. */
export interface MeasuredRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Registers (or clears, on unmount) the measurable host node of an image
 * thumbnail so the parent row can `measureInWindow` ANY thumbnail by index for
 * the close fly-back. Called with the host `View` on mount and `null` on unmount.
 */
export type RegisterThumbHost = (node: View | null) => void;

const webGrabCursorStyle: ViewStyle | null = Platform.OS === 'web'
  ? ({ cursor: 'grab' } as unknown as ViewStyle)
  : null;

const MIN_WIDTH = 100;

// A single-media video/gif card needs a DEFINITE height on native: the native
// `VideoView` has no auto-height, so a height-less container lets it overflow
// downward and `overflow:hidden` cannot clip a native child. We fix the width to
// the standard card width and derive the height from the video's real aspect
// ratio (reported by the player once metadata loads), clamped so a very tall
// portrait video cannot run off-screen (excess is letterboxed by contentFit
// "contain"). Web is left on its intrinsic auto-height — the HTML <video> sizes
// itself from the aspect ratio at the fixed width, so it never overflows and
// must not be forced into a box.
const SINGLE_MEDIA_FALLBACK_ASPECT_RATIO = MEDIA_CARD_WIDTH / MEDIA_CARD_HEIGHT;
/** Portrait floor (4:5) — the tallest a single-media card may grow before clamping. */
const SINGLE_MEDIA_MIN_ASPECT_RATIO = 4 / 5;
const SINGLE_MEDIA_MAX_HEIGHT = Math.round(MEDIA_CARD_WIDTH / SINGLE_MEDIA_MIN_ASPECT_RATIO);

/**
 * Sizing for a single-media video/gif card. Learns the video's intrinsic aspect
 * ratio (reported by `<VideoPlayer onAspectRatio>` once metadata loads) and
 * returns the card style plus the `onAspectRatio` handler to feed back. On native
 * the card always carries a DEFINITE height (aspect-derived, clamped) so the
 * native video view is bounded and clipped; on web only the width is fixed so the
 * <video> keeps its intrinsic auto-height.
 */
function useSingleMediaCardStyle(): {
  cardStyle: ViewStyle;
  onAspectRatio: (ratio: number) => void;
} {
  const [aspectRatio, setAspectRatio] = useState<number | undefined>(undefined);
  const onAspectRatio = useCallback((ratio: number) => {
    setAspectRatio((prev) => (prev === ratio ? prev : ratio));
  }, []);
  const cardStyle = useMemo<ViewStyle>(() => {
    if (Platform.OS === 'web') {
      return { width: MEDIA_CARD_WIDTH };
    }
    return {
      width: MEDIA_CARD_WIDTH,
      aspectRatio: aspectRatio ?? SINGLE_MEDIA_FALLBACK_ASPECT_RATIO,
      maxHeight: SINGLE_MEDIA_MAX_HEIGHT,
    };
  }, [aspectRatio]);
  return { cardStyle, onAspectRatio };
}

interface PostAttachmentMediaProps {
  type: 'image' | 'video' | 'gif';
  src: string;
  /**
   * Image only: author-authored accessibility description (Bluesky-style "ALT").
   * When present, renders a small "ALT" badge over the image and is used as the
   * image's screen-reader accessibility label.
   */
  alt?: string;
  mediaId?: string;
  postId?: string;
  /** Poster (thumbnail) shown over the video until the first frame plays. */
  poster?: string;
  /**
   * Video: fired with no args (routes to the reels viewer).
   * Image: fired with the measured on-screen rect of the tapped thumbnail so the
   * gallery can animate the zoom from the image's origin.
   */
  onPress?: (rect?: MeasuredRect) => void;
  hasSingleMedia?: boolean;
  hasMultipleMedia?: boolean;
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

const PostAttachmentVideo: React.FC<{
  src: string;
  poster?: string;
  onPress?: () => void;
  hasSingleMedia?: boolean;
  hasMultipleMedia?: boolean;
}> = ({ src, poster, onPress, hasSingleMedia, hasMultipleMedia }) => {
  const { cardStyle, onAspectRatio } = useSingleMediaCardStyle();
  return (
    <View
      className="border border-border bg-secondary rounded-[15px] overflow-hidden"
      style={[
        webGrabCursorStyle,
        hasMultipleMedia && { width: undefined, maxWidth: undefined, alignSelf: 'flex-start' as const },
        hasSingleMedia && cardStyle,
      ]}
    >
      <VideoPlayer
        src={src}
        poster={poster}
        style={hasSingleMedia ? styles.videoFill : styles.videoMultipleMedia}
        contentFit="contain"
        autoPlay={true}
        loop={true}
        onPress={onPress}
        onAspectRatio={hasSingleMedia ? onAspectRatio : undefined}
      />
    </View>
  );
};

// Inline looping muted GIF rendered as an mp4 video (like X/Meta). Mirrors
// PostAttachmentVideo's container/sizing, but with gif semantics: always muted,
// no controls, no mute toggle, and the surface is NOT tappable (no reels/lightbox).
const PostAttachmentGif: React.FC<{
  src: string;
  hasSingleMedia?: boolean;
  hasMultipleMedia?: boolean;
}> = ({ src, hasSingleMedia, hasMultipleMedia }) => {
  const { cardStyle, onAspectRatio } = useSingleMediaCardStyle();
  return (
    <View
      className="border border-border bg-secondary rounded-[15px] overflow-hidden"
      style={[
        webGrabCursorStyle,
        hasMultipleMedia && { width: undefined, maxWidth: undefined, alignSelf: 'flex-start' as const },
        hasSingleMedia && cardStyle,
      ]}
    >
      <VideoPlayer
        src={src}
        style={hasSingleMedia ? styles.videoFill : styles.videoMultipleMedia}
        contentFit="contain"
        autoPlay={true}
        loop={true}
        gif={true}
        onAspectRatio={hasSingleMedia ? onAspectRatio : undefined}
      />
    </View>
  );
};

const FULL_DIMENSION = '100%' as const;

const PostAttachmentImage: React.FC<{
  src: string;
  alt?: string;
  onPress?: (rect?: MeasuredRect) => void;
  registerHost?: RegisterThumbHost;
}> = ({ src, alt, onPress, registerHost }) => {
  const theme = useTheme();
  const wrapperRef = useRef<View | null>(null);
  const [aspectRatio, setAspectRatio] = useState<number | undefined>(
    () => getAspectRatio(src)
  );

  // Callback ref: keep the local ref (for open-press measurement) AND mirror the
  // host into the parent's index registry (for the close fly-back). Registers on
  // mount, clears on unmount — no effect needed.
  const setHostRef = useCallback((node: View | null) => {
    wrapperRef.current = node;
    registerHost?.(node);
  }, [registerHost]);

  useEffect(() => {
    if (hasAspectRatio(src)) {
      setAspectRatio(getAspectRatio(src));
      return;
    }
    let cancelled = false;
    Image.getSize(
      src,
      (width, height) => {
        if (cancelled) return;
        if (width > 0 && height > 0) {
          const ratio = width / height;
          setAspectRatio(ratio);
          // Persist to the shared cache so the gallery reuses it on open.
          setAspectRatioInCache(src, ratio);
        }
      },
      () => {
        if (cancelled) return;
        setAspectRatio(DEFAULT_ASPECT_RATIO);
        setAspectRatioInCache(src, DEFAULT_ASPECT_RATIO);
      }
    );
    return () => { cancelled = true; };
  }, [src]);

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

  const computedWidth = aspectRatio !== undefined
    ? Math.max(MEDIA_CARD_HEIGHT * aspectRatio, MIN_WIDTH)
    : MEDIA_CARD_WIDTH;

  const containerStyles: ViewStyle[] = [
    styles.itemContainer,
    {
      borderColor: theme.colors.border,
      backgroundColor: theme.colors.backgroundSecondary,
      height: MEDIA_CARD_HEIGHT,
      width: computedWidth,
    },
  ];
  if (webGrabCursorStyle) {
    containerStyles.push(webGrabCursorStyle);
  }

  const hasAlt = typeof alt === 'string' && alt.trim().length > 0;

  const lazyImage = (
    <LazyImage
      source={{ uri: src }}
      containerStyle={containerStyles}
      style={styles.fullSize}
      resizeMode="cover"
      accessibilityLabel={hasAlt ? alt : undefined}
      placeholder={
        <View
          className="bg-secondary justify-center items-center"
          style={{ width: computedWidth, height: MEDIA_CARD_HEIGHT }}
        />
      }
      threshold={300}
    />
  );

  // Bluesky-style "ALT" badge: a small dark pill in the image's bottom-left
  // corner, non-interactive so it never swallows the tap that opens the lightbox.
  const imageContent = hasAlt ? (
    <View>
      {lazyImage}
      <View
        pointerEvents="none"
        className="absolute bottom-1 left-1 bg-black/60 rounded px-1 py-0.5"
      >
        <Text className="text-white text-[10px] font-bold">ALT</Text>
      </View>
    </View>
  ) : lazyImage;

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
      hitSlop={8}
    >
      <BlurView
        intensity={SENSITIVE_BLUR_INTENSITY}
        tint="dark"
        experimentalBlurMethod="dimezisBlurView"
        style={StyleSheet.absoluteFill}
      />
      <View className="items-center gap-1">
        <Ionicons name="eye-off" size={24} color="#fff" />
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
  alt,
  poster,
  onPress,
  hasSingleMedia,
  hasMultipleMedia,
  registerHost,
  sensitive,
}) => {
  // Per-cell reveal state: each media item owns its own boolean, so revealing
  // one never reveals the rest of the row.
  const [revealed, setRevealed] = useState(false);

  let media: React.ReactNode;
  if (type === 'video') {
    media = (
      <PostAttachmentVideo
        src={src}
        poster={poster}
        onPress={onPress}
        hasSingleMedia={hasSingleMedia}
        hasMultipleMedia={hasMultipleMedia}
      />
    );
  } else if (type === 'gif') {
    media = (
      <PostAttachmentGif
        src={src}
        hasSingleMedia={hasSingleMedia}
        hasMultipleMedia={hasMultipleMedia}
      />
    );
  } else {
    media = <PostAttachmentImage src={src} alt={alt} onPress={onPress} registerHost={registerHost} />;
  }

  if (!sensitive) {
    return media;
  }

  // Keep the media mounted under the cover so revealing does not remount/reload
  // it — the cover simply unmounts, uncovering the already-painted media.
  return (
    <View style={styles.sensitiveWrapper}>
      {media}
      {!revealed && <SensitiveMediaCover onReveal={() => setRevealed(true)} />}
    </View>
  );
};

const styles = StyleSheet.create({
  itemContainer: {
    borderWidth: 1,
    borderRadius: MEDIA_CARD_RADIUS,
    overflow: 'hidden',
  },
  fullSize: {
    width: FULL_DIMENSION,
    height: FULL_DIMENSION,
  },
  // Fills the single-media card, which owns the definite (aspect-derived) box on
  // native and a fixed width with intrinsic auto-height on web.
  videoFill: {
    width: FULL_DIMENSION,
    height: FULL_DIMENSION,
  },
  videoMultipleMedia: {
    height: MEDIA_CARD_HEIGHT,
    alignSelf: 'flex-start',
  },
  // Hugs the media's intrinsic size in the horizontal row so the absolute cover
  // matches the cell exactly.
  sensitiveWrapper: {
    alignSelf: 'flex-start',
  },
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
