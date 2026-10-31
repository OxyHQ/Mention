import type React from 'react';
import { useCallback, useMemo, useRef, useState } from 'react';
import {
  Pressable,
  StyleSheet,
  View,
  type StyleProp,
  type ViewStyle,
  type ViewInstance,
} from 'react-native';
import type { AvatarProps } from '@oxy.so/bloom/avatar';
import { AccountAvatar } from '@/components/ui/AccountAvatar';
import { hasAccountAvatarCharacter } from '@/components/ui/use-account-avatar-motion';
import Animated, {
  Extrapolation,
  interpolate,
  useAnimatedStyle,
  type SharedValue,
} from 'react-native-reanimated';
import { useImageResolver } from '@oxy.so/bloom/image-resolver';
import {
  ZoomableMediaGallery,
  type MeasuredRect,
  type ZoomableMediaGalleryHandle,
} from '@oxy.so/bloom/zoomable-media-gallery';
import { useAuth, useFileDownloadUrl } from '@oxy.so/services/ui/client';

import DefaultAvatar from '@/assets/images/default-avatar.jpg';
import { MEDIA_VARIANT_FULL, MEDIA_VARIANT_AVATAR_LG } from '@mention/shared-types/post';

interface ZoomableAvatarProps {
  /** An Oxy file id, an absolute URL, or an expo-image source (a bundled asset). */
  source?: AvatarProps['source'];
  account?: AvatarProps['account'];
  size?: number;
  style?: StyleProp<ViewStyle>;
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
 * Circular avatar that opens Bloom's `ZoomableMediaGallery` when tapped.
 *
 * The zoom itself — fly-from-thumbnail, pinch, drag-to-dismiss, the blurred
 * backdrop, the fly-back — belongs to the gallery, which is the same viewer
 * post images use. This component only owns what is avatar-specific: resolving
 * the Oxy file id to the right rendition, the circular frame, and the
 * scroll-collapse transform.
 */
export const ZoomableAvatar: React.FC<ZoomableAvatarProps> = ({
  source,
  account,
  size = 40,
  style,
  className,
  collapseProgress,
  collapseMinScale = 1,
  collapseTranslateY = 0,
}) => {
  const { oxyServices } = useAuth();
  const hasCharacter = hasAccountAvatarCharacter(account);
  const [imageFailure, setImageFailure] = useState({ source, failed: false });
  if (imageFailure.source !== source) setImageFailure({ source, failed: false });
  const errored = imageFailure.source === source && imageFailure.failed;
  const imageResolver = useImageResolver();
  const wrapperRef = useRef<ViewInstance>(null);
  const galleryRef = useRef<ZoomableMediaGalleryHandle>(null);

  // An absolute http(s) `source` is a FINAL, server-resolved URL. A non-http
  // string is a raw Oxy file id (legacy profile-design data) resolved through
  // the app resolver, with `useFileDownloadUrl` as the async fallback.
  const fileId =
    !hasCharacter && typeof source === 'string' && !source.startsWith('http') ? source : undefined;
  // The resting avatar is 70–90px, so it takes the 256px square crop; the zoomed
  // image fills most of the screen, so it takes the 2048px rendition. BOTH pass
  // an explicit variant: the app resolver defaults a missing one to the 96px
  // avatar crop, which is what made the zoom look pixelated.
  const resolvedThumb = fileId ? imageResolver?.(fileId, MEDIA_VARIANT_AVATAR_LG) : undefined;
  const resolvedFull = fileId ? imageResolver?.(fileId, MEDIA_VARIANT_FULL) : undefined;
  const asyncThumb =
    useFileDownloadUrl(oxyServices, errored ? undefined : fileId, {
      variant: MEDIA_VARIANT_AVATAR_LG,
    }).url ?? undefined;

  const thumbUri = useMemo(() => {
    if (!source || errored) return undefined;
    if (typeof source !== 'string') return undefined;
    if (source.startsWith('http')) return source;
    return resolvedThumb ?? asyncThumb;
  }, [source, errored, resolvedThumb, asyncThumb]);

  const zoomUri = useMemo(() => {
    if (errored) return undefined;
    if (typeof source === 'string' && source.startsWith('http')) return source;
    return resolvedFull ?? thumbUri;
  }, [source, errored, resolvedFull, thumbUri]);

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
    if (hasCharacter || !zoomUri) return;
    void measureThumb().then((rect) => {
      galleryRef.current?.open(
        [{ uri: zoomUri, previewUri: thumbUri, aspectRatio: 1 }],
        0,
        rect ?? undefined,
      );
    });
  }, [measureThumb, zoomUri, thumbUri, hasCharacter]);

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
      <Pressable
        onPress={handlePress}
        disabled={hasCharacter || !zoomUri}
        accessibilityLabel="Profile avatar"
        accessibilityRole="image"
      >
        <View ref={wrapperRef} collapsable={false}>
          <Animated.View
            className={`web:[user-select:none] web:[-webkit-user-drag:none] web:cursor-pointer${className ? ` ${className}` : ''}`}
            style={[
              styles.avatar,
              { width: size, height: size, borderRadius: size / 2 },
              style,
              collapseStyle,
              hasCharacter && { overflow: 'visible' },
            ]}
          >
            <AccountAvatar
              account={account}
              onImageError={() => setImageFailure({ source, failed: true })}
              source={imageSource}
              fallbackSource={DefaultAvatar}
              size={size}
              shape="circle"
              style={StyleSheet.absoluteFill}
            />
          </Animated.View>
        </View>
      </Pressable>

      <ZoomableMediaGallery ref={galleryRef} measureThumb={measureThumb} cornerRadius="circle" />
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
