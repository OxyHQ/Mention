import React, { useState, useCallback, useMemo, useRef } from 'react';
import {
  View,
  StyleSheet,
  ImageSourcePropType,
  Pressable,
  Modal,
  Platform,
  useWindowDimensions,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { Image, type ImageStyle } from 'expo-image';
import { Image as RNImage } from 'react-native';
import { BlurView } from 'expo-blur';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
  withTiming,
  runOnJS,
  Easing,
  interpolate,
  Extrapolation,
  type SharedValue,
} from 'react-native-reanimated';
import {
  GestureHandlerRootView,
  Gesture,
  GestureDetector,
} from 'react-native-gesture-handler';
import { useTheme } from '@oxyhq/bloom/theme';
import { useImageResolver } from '@oxyhq/bloom/image-resolver';
import { useAuth } from '@oxyhq/services';
import { useImageUrl } from '@/hooks/useImageUrl';
import { MEDIA_VARIANT_VIDEO_POSTER } from '@mention/shared-types';
import DefaultAvatar from '@/assets/images/default-avatar.jpg';
import { Portal } from '@oxyhq/bloom/portal';
import {
  OPEN_SPRING,
  CLOSE_SPRING,
  SNAP_BACK_SPRING,
  OPEN_DURATION_WEB,
  CLOSE_DURATION_WEB,
  OPACITY_DURATION,
  MAX_DRAG_FRACTION,
  SCALE_DRAG_FRACTION,
  MIN_DRAG_SCALE,
  DISMISS_FRACTION,
} from '@oxyhq/bloom/zoomable-image-gallery';

const AnimatedBlurView = Animated.createAnimatedComponent(BlurView);
const AnimatedImage = Animated.createAnimatedComponent(Image);

// Memoize the default avatar source to prevent re-creation on every render
const DEFAULT_AVATAR_SOURCE = DefaultAvatar;

interface ZoomableAvatarProps {
  source?: ImageSourcePropType | string | undefined | null;
  size?: number;
  style?: StyleProp<ViewStyle>;
  imageStyle?: StyleProp<ImageStyle>;
  className?: string;
  /**
   * Optional scroll-collapse driver in the range 0 (expanded) → 1 (fully
   * collapsed). When provided, the resting (non-zoomed) avatar scales toward
   * `collapseMinScale` and shifts down by `collapseTranslateY` as the value
   * moves 0 → 1 — the classic "avatar shrinks into the header" effect on a
   * scrollable profile/detail screen. The caller derives this normalized value
   * from its own scroll source, so `ZoomableAvatar` stays generic. The shrink is
   * purely additive to the tap-to-zoom transform and is gated OFF while zoomed.
   */
  collapseProgress?: SharedValue<number>;
  /** Scale the resting avatar reaches at full collapse (default 1 = no shrink). */
  collapseMinScale?: number;
  /** Downward shift (px) the resting avatar reaches at full collapse (default 0). */
  collapseTranslateY?: number;
}

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
  const theme = useTheme();
  const { oxyServices } = useAuth();
  const imageResolver = useImageResolver();
  const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = useWindowDimensions();
  const [isZoomed, setIsZoomed] = useState(false);
  const [errored, setErrored] = useState(false);
  const [originalImageSize, setOriginalImageSize] = useState<number | null>(null);
  const avatarWrapperRef = useRef<View>(null);
  
  // Calculate max zoom size based on current screen dimensions (responsive)
  // Also respect max width of 25rem (400px assuming 16px base font size)
  // And use original image size if it's smaller
  const MAX_ZOOM_SIZE = useMemo(
    () => {
      const maxFromScreen = Math.min(SCREEN_WIDTH * 0.75, SCREEN_HEIGHT * 0.75);
      const maxWidthRem = 25 * 16; // 25rem = 400px (assuming 16px base font size)
      const calculatedMax = Math.min(maxFromScreen, maxWidthRem);
      
      // If we know the original image size and it's smaller, use that
      if (originalImageSize && originalImageSize < calculatedMax) {
        return originalImageSize;
      }
      
      return calculatedMax;
    },
    [SCREEN_WIDTH, SCREEN_HEIGHT, originalImageSize]
  );

  // Animation values
  const scale = useSharedValue(1);
  const translateX = useSharedValue(0);
  const translateY = useSharedValue(0);
  const opacity = useSharedValue(0);
  
  // Store original avatar position (relative to screen center)
  const originX = useSharedValue(0);
  const originY = useSharedValue(0);

  // An absolute http(s) `source` is a FINAL, server-resolved URL — render it
  // directly. Defensive fallback: a non-http string is a legacy raw Oxy file id
  // (old profile-design data) and is resolved asynchronously via useImageUrl
  // (instant on cache hit, async on miss).
  const fileIdSource = typeof source === 'string' && !source.startsWith('http') ? source : undefined;
  // ZoomableAvatar renders LARGE profile avatars (70–90px) and taps zoom to a
  // ~400px fullscreen image, so it needs the 256px square crop (VIDEO_POSTER),
  // NOT the 128px `avatar` crop small avatars use. Pass the variant explicitly to
  // both resolution paths so it never inherits the resolver's small-avatar default.
  const providerResolvedUrl = fileIdSource
    ? imageResolver?.(fileIdSource, MEDIA_VARIANT_VIDEO_POSTER)
    : undefined;
  const resolvedUrl = useImageUrl(errored ? undefined : fileIdSource, MEDIA_VARIANT_VIDEO_POSTER, oxyServices);

  const resolvedSource = useMemo(() => {
    if (!source || errored) return undefined;
    if (typeof source !== 'string') return source;
    if (source.startsWith('http')) return source;
    return providerResolvedUrl ?? resolvedUrl;
  }, [source, errored, providerResolvedUrl, resolvedUrl]);

  React.useEffect(() => {
    setErrored(false);
  }, [source, resolvedUrl, providerResolvedUrl]);

  const imageSource = useMemo(() => {
    if (resolvedSource) {
      return typeof resolvedSource === 'string' ? { uri: resolvedSource } : resolvedSource;
    }
    return DEFAULT_AVATAR_SOURCE;
  }, [resolvedSource]);

  // Get original image dimensions when resolved source changes
  React.useEffect(() => {
    if (!resolvedSource || errored) {
      setOriginalImageSize(null);
      return;
    }

    const getImageSize = async () => {
      try {
        let imageUri: string | undefined;

        if (typeof resolvedSource === 'string') {
          imageUri = resolvedSource;
        } else if (resolvedSource && typeof resolvedSource === 'object' && 'uri' in resolvedSource && resolvedSource.uri) {
          imageUri = resolvedSource.uri;
        }
        
        if (imageUri && (imageUri.startsWith('http') || imageUri.startsWith('https'))) {
          // Remote image - use React Native's Image.getSize
          const { width, height } = await new Promise<{ width: number; height: number }>((resolve, reject) => {
            RNImage.getSize(
              imageUri!,
              (width, height) => resolve({ width, height }),
              reject
            );
          });
          
          if (width && height) {
            const imageSize = Math.min(width, height);
            setOriginalImageSize(imageSize);
          }
        }
        // For local images, dimensions will be captured via onLoad
      } catch (error) {
        // If getSize fails, dimensions will be captured via onLoad if available
        // Silently fail - onLoad will handle it
      }
    };

    getImageSize();
  }, [resolvedSource, errored]);

  const handlePress = useCallback(() => {
    if (!isZoomed && avatarWrapperRef.current) {
      // Measure avatar position relative to window
      // On native, we might need a small delay for accurate measurement
      const measureCallback = (pageX: number, pageY: number, width: number, height: number) => {
        // Calculate position relative to screen center
        const centerX = SCREEN_WIDTH / 2;
        const centerY = SCREEN_HEIGHT / 2;
        const avatarCenterX = pageX + width / 2;
        const avatarCenterY = pageY + height / 2;
        
        // Store origin position (offset from screen center)
        originX.value = avatarCenterX - centerX;
        originY.value = avatarCenterY - centerY;
        
        setIsZoomed(true);
        // Start from avatar position
        translateX.value = originX.value;
        translateY.value = originY.value;
        // Start with current scale
        scale.value = 1;
        opacity.value = 0;
        
        // Calculate zoom scale to max 75% of screen (responsive)
        // Scale from avatar size to MAX_ZOOM_SIZE
        const zoomScale = MAX_ZOOM_SIZE / size;
        
        // Animate to zoomed state (centered) with smooth, coordinated animations
        if (Platform.OS === 'web') {
          // Web: use timing with easing
          requestAnimationFrame(() => {
            const duration = OPEN_DURATION_WEB;
            const easing = Easing.out(Easing.cubic);
            scale.value = withTiming(zoomScale, { duration, easing });
            translateX.value = withTiming(0, { duration, easing });
            translateY.value = withTiming(0, { duration, easing });
            opacity.value = withTiming(1, { duration, easing });
          });
        } else {
          // Native: use spring animations on UI thread for best performance
          // Reduced delay for immediate response
          setTimeout(() => {
            scale.value = withSpring(zoomScale, OPEN_SPRING);
            translateX.value = withSpring(0, OPEN_SPRING);
            translateY.value = withSpring(0, OPEN_SPRING);
            opacity.value = withTiming(1, { duration: OPACITY_DURATION });
          }, 0);
        }
      };
      
      if (Platform.OS === 'web') {
        avatarWrapperRef.current.measureInWindow(measureCallback);
      } else {
        // On native, add a small delay for accurate measurement
        setTimeout(() => {
          if (avatarWrapperRef.current) {
            avatarWrapperRef.current.measureInWindow(measureCallback);
          }
        }, 10);
      }
    }
  }, [isZoomed, size]);

  const handleDismiss = useCallback(() => {
    // Animate back to original position with smooth, coordinated animations
    if (Platform.OS === 'web') {
      // Web: use timing with easing
      const duration = CLOSE_DURATION_WEB;
      const easing = Easing.in(Easing.cubic);
      scale.value = withTiming(1, { duration, easing });
      translateX.value = withTiming(originX.value, { duration, easing });
      translateY.value = withTiming(originY.value, { duration, easing });
      opacity.value = withTiming(0, { duration, easing });
      
      setTimeout(() => {
        setIsZoomed(false);
        scale.value = 1;
        translateX.value = 0;
        translateY.value = 0;
        opacity.value = 0;
      }, duration + 20);
    } else {
      // Native: use optimized spring for smooth, fast animations
      scale.value = withSpring(1, CLOSE_SPRING);
      translateX.value = withSpring(originX.value, CLOSE_SPRING);
      translateY.value = withSpring(originY.value, CLOSE_SPRING);
      opacity.value = withTiming(0, { duration: OPACITY_DURATION });

      // Spring animations complete faster with higher stiffness
      setTimeout(() => {
        setIsZoomed(false);
        scale.value = 1;
        translateX.value = 0;
        translateY.value = 0;
        opacity.value = 0;
      }, CLOSE_DURATION_WEB);
    }
  }, []);

  const startX = useSharedValue(0);
  const startY = useSharedValue(0);
  const startScale = useSharedValue(1);

  const panGesture = useMemo(
    () =>
      Gesture.Pan()
        .enabled(isZoomed)
        .minDistance(Platform.OS === 'ios' ? 0 : 5) // iOS is more sensitive
        .onStart(() => {
          // Capture starting position and scale
          startX.value = translateX.value;
          startY.value = translateY.value;
          startScale.value = scale.value;
        })
        .onUpdate((event) => {
          // Follow finger during drag
          translateX.value = startX.value + event.translationX;
          translateY.value = startY.value + event.translationY;

          // Calculate drag distance for opacity (use current screen height)
          const dragDistance = Math.sqrt(
            event.translationX ** 2 + event.translationY ** 2
          );
          const maxDrag = SCREEN_HEIGHT * MAX_DRAG_FRACTION;
          const opacityValue = Math.max(0, 1 - dragDistance / maxDrag);
          opacity.value = opacityValue;

          // Scale down slightly when dragging
          const scaleReduction = Math.max(MIN_DRAG_SCALE, 1 - dragDistance / (SCREEN_HEIGHT * SCALE_DRAG_FRACTION));
          scale.value = startScale.value * scaleReduction;
        })
        .onEnd((event) => {
          const dragDistance = Math.sqrt(
            event.translationX ** 2 + event.translationY ** 2
          );
          const dismissThreshold = SCREEN_HEIGHT * DISMISS_FRACTION;

          if (dragDistance > dismissThreshold) {
            // Dragged far enough — dismiss
            runOnJS(handleDismiss)();
          } else {
            // Snap back to center (stay zoomed)
            const zoomScale = MAX_ZOOM_SIZE / size;
            scale.value = withSpring(zoomScale, SNAP_BACK_SPRING);
            translateX.value = withSpring(0, SNAP_BACK_SPRING);
            translateY.value = withSpring(0, SNAP_BACK_SPRING);
            opacity.value = withTiming(1, { duration: OPACITY_DURATION });
          }
        }),
    [handleDismiss, isZoomed, SCREEN_HEIGHT, MAX_ZOOM_SIZE, size]
  );

  // Style for the small avatar (not zoomed). When a `collapseProgress` driver is
  // supplied, the resting avatar shrinks toward `collapseMinScale` and slides
  // down by `collapseTranslateY` as the value goes 0 → 1. The shrink is gated OFF
  // while zoomed so it never fights the tap-to-zoom transform.
  const avatarAnimatedStyle = useAnimatedStyle(() => {
    if (isZoomed) {
      return {
        opacity: 0,
      };
    }
    const progress = collapseProgress?.value ?? 0;
    return {
      opacity: 1,
      transform: [
        { scale: interpolate(progress, [0, 1], [1, collapseMinScale], Extrapolation.CLAMP) },
        { translateY: interpolate(progress, [0, 1], [0, collapseTranslateY], Extrapolation.CLAMP) },
      ],
      borderRadius: size / 2,
    };
  });

  // Style for the zoomed image
  const zoomedImageAnimatedStyle = useAnimatedStyle(() => {
    // Calculate max scale based on current screen dimensions (responsive)
    // Also respect max width of 25rem (400px) and original image size
    const maxFromScreen = Math.min(SCREEN_WIDTH * 0.75, SCREEN_HEIGHT * 0.75);
    const maxWidthRem = 25 * 16; // 25rem = 400px
    let currentMaxZoom = Math.min(maxFromScreen, maxWidthRem);
    
    // If original image is smaller, use that
    if (originalImageSize && originalImageSize < currentMaxZoom) {
      currentMaxZoom = originalImageSize;
    }
    
    const maxScale = currentMaxZoom / size;
    const clampedScale = Math.min(scale.value, maxScale);
    const visualSize = size * clampedScale;
    
    return {
      transform: [
        { scale: clampedScale },
        { translateX: translateX.value },
        { translateY: translateY.value },
      ],
      borderRadius: visualSize / 2, // Keep it circular at current scale
    };
  }, [size, SCREEN_WIDTH, SCREEN_HEIGHT, originalImageSize]);

  const blurAnimatedStyle = useAnimatedStyle(() => {
    return {
      opacity: opacity.value,
    };
  });

  return (
    <>
      <Pressable onPress={handlePress} disabled={isZoomed} accessibilityLabel="Profile avatar" accessibilityRole="image">
        <View
          ref={avatarWrapperRef}
          collapsable={false}
        >
          <Animated.View
            className={`web:[user-select:none] web:[-webkit-user-drag:none] web:cursor-pointer${className ? ` ${className}` : ''}`}
            style={[
              styles.avatarContainer,
              { width: size, height: size, borderRadius: size / 2 },
              style,
              avatarAnimatedStyle,
            ]}
          >
          <Image
            source={imageSource}
            onError={() => setErrored(true)}
            onLoad={(event) => {
              // Store original image dimensions
              const { width, height } = event.source;
              if (width && height) {
                // Use the smaller dimension to keep it square/circular
                const imageSize = Math.min(width, height);
                setOriginalImageSize(imageSize);
              }
            }}
            contentFit="cover"
            style={[
              StyleSheet.absoluteFill,
              { borderRadius: size / 2 },
              imageStyle,
            ]}
            transition={200}
            {...(Platform.OS === 'web' ? ({ draggable: false } as Record<string, unknown>) : {})}
          />
          </Animated.View>
        </View>
      </Pressable>

      {isZoomed && (
        <>
          {Platform.OS === 'web' ? (
            <Portal>
              <GestureHandlerRootView
                className="web:fixed web:inset-0 web:z-[10000]"
                style={styles.modalContainer}
              >
                <Pressable
                  style={StyleSheet.absoluteFill}
                  onPress={handleDismiss}
                  hitSlop={0}
                >
                  <AnimatedBlurView
                    intensity={80}
                    tint={theme.isDark ? 'dark' : 'light'}
                    experimentalBlurMethod="dimezisBlurView"
                    style={[StyleSheet.absoluteFill, blurAnimatedStyle]}
                  >
                    <Animated.View
                      style={[
                        StyleSheet.absoluteFill,
                        { backgroundColor: theme.colors.overlay },
                        blurAnimatedStyle,
                      ]}
                    />
                  </AnimatedBlurView>
                </Pressable>

                <GestureDetector gesture={panGesture}>
                  <Pressable
                    onPress={handleDismiss}
                    className="web:[user-select:none] web:[-webkit-user-drag:none] web:cursor-grab"
                    style={[
                      StyleSheet.absoluteFill,
                      styles.zoomContainer,
                      { width: SCREEN_WIDTH, height: SCREEN_HEIGHT },
                    ]}
                  >
                    <AnimatedImage
                      source={imageSource}
                      contentFit="cover"
                      onLoad={(event) => {
                        // Store original image dimensions if not already set
                        if (!originalImageSize) {
                          const { width, height } = event.source;
                          if (width && height) {
                            const imageSize = Math.min(width, height);
                            setOriginalImageSize(imageSize);
                          }
                        }
                      }}
                      style={[
                        {
                          width: size,
                          height: size,
                          borderRadius: size / 2,
                          overflow: 'hidden',
                          maxWidth: MAX_ZOOM_SIZE,
                          maxHeight: MAX_ZOOM_SIZE,
                        },
                        zoomedImageAnimatedStyle,
                      ]}
                      transition={200}
                      {...(Platform.OS === 'web' ? ({ draggable: false } as Record<string, unknown>) : {})}
                    />
                  </Pressable>
                </GestureDetector>
              </GestureHandlerRootView>
            </Portal>
          ) : (
            <Modal
              visible={isZoomed}
              transparent
              animationType="none"
              statusBarTranslucent={Platform.OS === 'android'}
              onRequestClose={handleDismiss}
              hardwareAccelerated={Platform.OS === 'android'}
            >
              <GestureHandlerRootView style={styles.modalContainer}>
                <Pressable
                  style={StyleSheet.absoluteFill}
                  onPress={handleDismiss}
                  hitSlop={0}
                >
                  <AnimatedBlurView
                    intensity={80}
                    tint={theme.isDark ? 'dark' : 'light'}
                    experimentalBlurMethod="dimezisBlurView"
                    style={[StyleSheet.absoluteFill, blurAnimatedStyle]}
                  >
                    <Animated.View
                      style={[
                        StyleSheet.absoluteFill,
                        { backgroundColor: theme.colors.overlay },
                        blurAnimatedStyle,
                      ]}
                    />
                  </AnimatedBlurView>
                </Pressable>

                <GestureDetector gesture={panGesture}>
                  <Animated.View
                    style={[
                      StyleSheet.absoluteFill,
                      styles.zoomContainer,
                      { width: SCREEN_WIDTH, height: SCREEN_HEIGHT },
                      { pointerEvents: 'auto' },
                    ]}
                  >
                    <AnimatedImage
                      source={imageSource}
                      contentFit="cover"
                      onLoad={(event) => {
                        // Store original image dimensions if not already set
                        if (!originalImageSize) {
                          const { width, height } = event.source;
                          if (width && height) {
                            const imageSize = Math.min(width, height);
                            setOriginalImageSize(imageSize);
                          }
                        }
                      }}
                      style={[
                        {
                          width: size,
                          height: size,
                          borderRadius: size / 2,
                          overflow: 'hidden',
                          maxWidth: MAX_ZOOM_SIZE,
                          maxHeight: MAX_ZOOM_SIZE,
                        },
                        zoomedImageAnimatedStyle,
                      ]}
                      transition={200}
                    />
                  </Animated.View>
                </GestureDetector>
              </GestureHandlerRootView>
            </Modal>
          )}
        </>
      )}
    </>
  );
};

const styles = StyleSheet.create({
  avatarContainer: {
    // WEB interaction hints (`user-select:none`, `-webkit-user-drag:none`,
    // `cursor:pointer`) live in NativeWind classes on the Animated.View — no
    // inline web-only style object / `as any` cast.
    position: 'relative',
    overflow: 'hidden',
    justifyContent: 'center',
    alignItems: 'center',
  },
  modalContainer: {
    // WEB full-screen overlay positioning lives in NativeWind classes on the
    // GestureHandlerRootView (`web:fixed web:inset-0 web:z-[10000]`). NATIVE: the
    // Modal-mounted root fills via flex.
    justifyContent: 'center',
    alignItems: 'center',
    ...Platform.select({
      web: {},
      default: {
        flex: 1,
        backgroundColor: 'transparent',
      },
    }),
  },
  zoomContainer: {
    // WEB interaction hints (`user-select:none`, `-webkit-user-drag:none`,
    // `cursor:grab`) live in NativeWind classes on the web zoom Pressable — no
    // inline web-only style object / `as any` cast.
    justifyContent: 'center',
    alignItems: 'center',
  },
});

export default ZoomableAvatar;
