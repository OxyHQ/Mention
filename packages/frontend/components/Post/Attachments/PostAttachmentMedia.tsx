import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Image, Pressable, View, StyleSheet, ViewStyle, Platform } from 'react-native';
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

interface PostAttachmentMediaProps {
  type: 'image' | 'video' | 'gif';
  src: string;
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
}

const PostAttachmentVideo: React.FC<{
  src: string;
  poster?: string;
  onPress?: () => void;
  hasSingleMedia?: boolean;
  hasMultipleMedia?: boolean;
}> = ({ src, poster, onPress, hasSingleMedia, hasMultipleMedia }) => {
  return (
    <View
      className="border border-border bg-secondary rounded-[15px] overflow-hidden"
      style={[
        webGrabCursorStyle,
        hasMultipleMedia && { width: undefined, maxWidth: undefined, alignSelf: 'flex-start' as const },
        hasSingleMedia && { maxHeight: undefined, height: undefined },
      ]}
    >
      <VideoPlayer
        src={src}
        poster={poster}
        style={hasSingleMedia ? styles.videoPreserveAspect : styles.videoMultipleMedia}
        contentFit="contain"
        autoPlay={true}
        loop={true}
        onPress={onPress}
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
  return (
    <View
      className="border border-border bg-secondary rounded-[15px] overflow-hidden"
      style={[
        webGrabCursorStyle,
        hasMultipleMedia && { width: undefined, maxWidth: undefined, alignSelf: 'flex-start' as const },
        hasSingleMedia && { maxHeight: undefined, height: undefined },
      ]}
    >
      <VideoPlayer
        src={src}
        style={hasSingleMedia ? styles.videoPreserveAspect : styles.videoMultipleMedia}
        contentFit="contain"
        autoPlay={true}
        loop={true}
        gif={true}
      />
    </View>
  );
};

const FULL_DIMENSION = '100%' as const;

const PostAttachmentImage: React.FC<{
  src: string;
  onPress?: (rect?: MeasuredRect) => void;
  registerHost?: RegisterThumbHost;
}> = ({ src, onPress, registerHost }) => {
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

  const lazyImage = (
    <LazyImage
      source={{ uri: src }}
      containerStyle={containerStyles}
      style={styles.fullSize}
      resizeMode="cover"
      placeholder={
        <View
          className="bg-secondary justify-center items-center"
          style={{ width: computedWidth, height: MEDIA_CARD_HEIGHT }}
        />
      }
      threshold={300}
    />
  );

  if (!onPress) {
    return lazyImage;
  }

  return (
    <Pressable
      ref={setHostRef}
      onPress={handlePress}
      accessibilityRole="imagebutton"
      accessibilityLabel="Open image"
      collapsable={false}
    >
      {lazyImage}
    </Pressable>
  );
};

const PostAttachmentMedia: React.FC<PostAttachmentMediaProps> = ({
  type,
  src,
  poster,
  onPress,
  hasSingleMedia,
  hasMultipleMedia,
  registerHost,
}) => {
  if (type === 'video') {
    return (
      <PostAttachmentVideo
        src={src}
        poster={poster}
        onPress={onPress}
        hasSingleMedia={hasSingleMedia}
        hasMultipleMedia={hasMultipleMedia}
      />
    );
  }

  if (type === 'gif') {
    return (
      <PostAttachmentGif
        src={src}
        hasSingleMedia={hasSingleMedia}
        hasMultipleMedia={hasMultipleMedia}
      />
    );
  }

  return <PostAttachmentImage src={src} onPress={onPress} registerHost={registerHost} />;
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
  videoPreserveAspect: {
    width: MEDIA_CARD_WIDTH,
  },
  videoMultipleMedia: {
    height: MEDIA_CARD_HEIGHT,
    alignSelf: 'flex-start',
  },
});

export default PostAttachmentMedia;
