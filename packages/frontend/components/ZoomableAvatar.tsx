import React, { useCallback, useMemo, useRef, useState } from 'react';
import {
  Platform,
  Pressable,
  StyleSheet,
  View,
  type ImageSourcePropType,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { Image, type ImageStyle } from 'expo-image';
import Animated, {
  Extrapolation,
  interpolate,
  useAnimatedStyle,
  type SharedValue,
} from 'react-native-reanimated';
import { useImageResolver } from '@oxyhq/bloom/image-resolver';
import {
  ZoomableImageGallery,
  type MeasuredRect,
  type ZoomableImageGalleryHandle,
} from '@oxyhq/bloom/zoomable-image-gallery';
import { useAuth } from '@oxyhq/services/ui/client';

import DefaultAvatar from '@/assets/images/default-avatar.jpg';
import { useImageUrl } from '@/hooks/useImageUrl';
import { MEDIA_VARIANT_FULL, MEDIA_VARIANT_VIDEO_POSTER } from '@mention/shared-types/post';

interface ZoomableAvatarProps {
  source?: ImageSourcePropType | string | undefined | null;
  size?: number;
  style?: StyleProp<ViewStyle>;
  imageStyle?: StyleProp<ImageStyle>;
  className?: string;
  /**
   * Scroll-collapse driver, 0 (expanded) → 1 (fully collapsed). The avatar
   * scales toward `collapseMinScale` and shifts down by `collapseTranslateY` as
   * it moves — the "avatar shrinks into the header" effect. The caller derives
   * the normalized value from its own scroll source.
   */
  collapseProgress?: SharedValue<number>;
  /** Scale the resting avatar reaches at full collapse (default 1 = no shrink). */
  collapseMinScale?: number;
  /** Downward shift (px) the resting avatar reaches at full collapse (default 0). */
  collapseTranslateY?: number;
}

/**
 * Circular avatar that opens Bloom's `ZoomableImageGallery` when tapped.
 *
 * The zoom itself — fly-from-thumbnail, pinch, drag-to-dismiss, the blurred
 * backdrop, the fly-back — belongs to the gallery, which is the same viewer
 * post images use. This component only owns what is avatar-specific: resolving
 * the Oxy file id to the right rendition, the circular frame, and the
 * scroll-collapse transform.
 */
export const ZoomableAvatar: React.FC<ZoomableAvatarProps> = ({
  source,
  size = 40,
  style,
  imageStyle,
  className,
  collapseProgress,
  collapseMinScale = 1,
  collapseTranslateY = 0,
}) => {
  const { oxyServices } = useAuth();
  const imageResolver = useImageResolver();
  const [errored, setErrored] = useState(false);
  // A new source has not failed yet. Reset during render rather than in an
  // effect, so `thumbUri` below never gets one committed frame of the previous
  // source's failure — which showed the default avatar over a perfectly good
  // new image.
  const [erroredSource, setErroredSource] = useState(source);
  if (erroredSource !== source) {
    setErroredSource(source);
    setErrored(false);
  }
  const wrapperRef = useRef<View>(null);
  const galleryRef = useRef<ZoomableImageGalleryHandle>(null);

  // An absolute http(s) `source` is a FINAL, server-resolved URL. A non-http
  // string is a raw Oxy file id (legacy profile-design data) resolved through
  // the app resolver, with `useImageUrl` as the async fallback on a cache miss.
  const fileId = typeof source === 'string' && !source.startsWith('http') ? source : undefined;
  // The resting avatar is 70–90px, so it takes the 256px square crop; the zoomed
  // image fills most of the screen, so it takes the 2048px rendition. BOTH pass
  // an explicit variant: the app resolver defaults a missing one to the 96px
  // avatar crop, which is what made the zoom look pixelated.
  const resolvedThumb = imageResolver?.(fileId ?? '', MEDIA_VARIANT_VIDEO_POSTER);
  const resolvedFull = imageResolver?.(fileId ?? '', MEDIA_VARIANT_FULL);
  const asyncThumb = useImageUrl(errored ? undefined : fileId, MEDIA_VARIANT_VIDEO_POSTER, oxyServices);

  const thumbUri = useMemo(() => {
    if (!source || errored) return undefined;
    if (typeof source !== 'string') return undefined;
    if (source.startsWith('http')) return source;
    return resolvedThumb ?? asyncThumb;
  }, [source, errored, resolvedThumb, asyncThumb]);

  const zoomUri = useMemo(() => {
    if (typeof source === 'string' && source.startsWith('http')) return source;
    return resolvedFull ?? thumbUri;
  }, [source, resolvedFull, thumbUri]);

  const imageSource = useMemo(() => {
    if (thumbUri) return { uri: thumbUri };
    // A non-string source is already an RN image source (bundled asset).
    if (source && typeof source !== 'string' && !errored) return source;
    return DefaultAvatar;
  }, [thumbUri, source, errored]);

  const measureThumb = useCallback(
    () =>
      new Promise<MeasuredRect | null>((resolve) => {
        const node = wrapperRef.current;
        if (!node) {
          resolve(null);
          return;
        }
        node.measureInWindow((x, y, width, height) => {
          resolve(width > 0 && height > 0 ? { x, y, width, height } : null);
        });
      }),
    [],
  );

  const handlePress = useCallback(() => {
    if (!zoomUri) return;
    void measureThumb().then((rect) => {
      galleryRef.current?.open([{ uri: zoomUri, aspectRatio: 1 }], 0, rect ?? undefined);
    });
  }, [measureThumb, zoomUri]);

  // Resting transform: the scroll-collapse shrink. Neutral (identity) when the
  // host passes no `collapseProgress`.
  const collapseStyle = useAnimatedStyle(() => {
    if (!collapseProgress) return {};
    const progress = collapseProgress.value;
    return {
      transform: [
        { translateY: interpolate(progress, [0, 1], [0, collapseTranslateY], Extrapolation.CLAMP) },
        { scale: interpolate(progress, [0, 1], [1, collapseMinScale], Extrapolation.CLAMP) },
      ],
    };
  }, [collapseProgress, collapseMinScale, collapseTranslateY]);

  return (
    <>
      <Pressable onPress={handlePress} accessibilityLabel="Profile avatar" accessibilityRole="image">
        <View ref={wrapperRef} collapsable={false}>
          <Animated.View
            className={`web:[user-select:none] web:[-webkit-user-drag:none] web:cursor-pointer${className ? ` ${className}` : ''}`}
            style={[
              styles.avatar,
              { width: size, height: size, borderRadius: size / 2 },
              style,
              collapseStyle,
            ]}
          >
            <Image
              source={imageSource}
              onError={() => setErrored(true)}
              contentFit="cover"
              style={[StyleSheet.absoluteFill, { borderRadius: size / 2 }, imageStyle]}
              transition={200}
              {...(Platform.OS === 'web' ? ({ draggable: false } as Record<string, unknown>) : {})}
            />
          </Animated.View>
        </View>
      </Pressable>

      <ZoomableImageGallery ref={galleryRef} measureThumb={measureThumb} cornerRadius="circle" />
    </>
  );
};

const styles = StyleSheet.create({
  avatar: {
    // Web interaction hints (`user-select`, `-webkit-user-drag`, `cursor`) ride
    // on the NativeWind classes above, not an inline web-only style object.
    position: 'relative',
    overflow: 'hidden',
    justifyContent: 'center',
    alignItems: 'center',
  },
});

export default ZoomableAvatar;
