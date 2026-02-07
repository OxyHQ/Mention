import React, { useState, useCallback, useMemo, useRef } from 'react';
import {
  View,
  StyleSheet,
  ImageSourcePropType,
  Pressable,
  Modal,
  Platform,
  useWindowDimensions,
} from 'react-native';
import { Image } from 'expo-image';
import { Image as RNImage } from 'react-native';
import { BlurView } from 'expo-blur';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
  withTiming,
  runOnJS,
  runOnUI,
  Easing,
} from 'react-native-reanimated';
import {
  GestureHandlerRootView,
  Gesture,
  GestureDetector,
} from 'react-native-gesture-handler';
import { useTheme } from '@/hooks/useTheme';
import { useAuth } from '@oxyhq/services';
import { getCachedFileDownloadUrlSync } from '@/utils/imageUrlCache';
import DefaultAvatar from '@/assets/images/default-avatar.jpg';
import { Portal } from '@/components/Portal';
import { Z_INDEX } from '@/lib/constants';

const AnimatedBlurView = Animated.createAnimatedComponent(BlurView);
const AnimatedImage = Animated.createAnimatedComponent(Image);

// Memoize the default avatar source to prevent re-creation on every render
const DEFAULT_AVATAR_SOURCE = DefaultAvatar;

interface ZoomableAvatarProps {
  source?: ImageSourcePropType | string | undefined | null;
  size?: number;
  style?: any;
  imageStyle?: any;
}

export const ZoomableAvatar: React.FC<ZoomableAvatarProps> = ({
  source,
  size = 40,
  style,
  imageStyle,
}) => {
  const theme = useTheme();
  const { oxyServices } = useAuth();
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

  // Resolve source: handles file IDs, HTTP URLs, and ImageSourcePropType objects
  const resolvedSource = useMemo(() => {
    if (!source || errored) return undefined;
    if (typeof source !== 'string') return source;
    if (source.startsWith('http')) return source;
    if (oxyServices) {
      try {
        return getCachedFileDownloadUrlSync(oxyServices, source, 'thumb');
      } catch {
        return undefined;
      }
    }
    return undefined;
  }, [source, errored, oxyServices]);

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
            const duration = 300;
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
            const springConfig = {
              damping: 18,
              stiffness: 400,
              mass: 0.4,
            };
            scale.value = withSpring(zoomScale, springConfig);
            translateX.value = withSpring(0, springConfig);
            translateY.value = withSpring(0, springConfig);
            opacity.value = withTiming(1, { duration: 200 });
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
      const duration = 280;
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
      const springConfig = {
        damping: 22,
        stiffness: 450,
        mass: 0.35,
      };
      scale.value = withSpring(1, springConfig);
      translateX.value = withSpring(originX.value, springConfig);
      translateY.value = withSpring(originY.value, springConfig);
      opacity.value = withTiming(0, { duration: 200 });
      
      // Spring animations complete faster with higher stiffness
      setTimeout(() => {
        setIsZoomed(false);
        scale.value = 1;
        translateX.value = 0;
        translateY.value = 0;
        opacity.value = 0;
      }, 280);
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
          const maxDrag = SCREEN_HEIGHT * 0.3;
          const opacityValue = Math.max(0, 1 - dragDistance / maxDrag);
          opacity.value = opacityValue;

          // Scale down slightly when dragging
          const scaleReduction = Math.max(0.5, 1 - dragDistance / (SCREEN_HEIGHT * 0.5));
          scale.value = startScale.value * scaleReduction;
        })
        .onEnd(() => {
          // When finger is released, always return to original position and dismiss
          runOnJS(handleDismiss)();
        }),
    [handleDismiss, isZoomed, SCREEN_HEIGHT]
  );

  // Style for the small avatar (not zoomed)
  const avatarAnimatedStyle = useAnimatedStyle(() => {
    if (isZoomed) {
      return {
        opacity: 0,
      };
    }
    return {
      opacity: 1,
      transform: [
        { scale: 1 },
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
      <Pressable onPress={handlePress} disabled={isZoomed}>
        <View
          ref={avatarWrapperRef}
          collapsable={false}
        >
          <Animated.View
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
              StyleSheet.absoluteFillObject,
              { borderRadius: size / 2 },
              imageStyle,
            ]}
            transition={200}
          />
          </Animated.View>
        </View>
      </Pressable>

      {isZoomed && (
        <>
          {Platform.OS === 'web' ? (
            <Portal>
              <GestureHandlerRootView style={styles.modalContainer}>
                <Pressable
                  style={StyleSheet.absoluteFillObject}
                  onPress={handleDismiss}
                  hitSlop={0}
                >
                  <AnimatedBlurView
                    intensity={80}
                    tint={theme.isDark ? 'dark' : 'light'}
                    style={[StyleSheet.absoluteFillObject, blurAnimatedStyle]}
                  >
                    <Animated.View
                      style={[
                        StyleSheet.absoluteFillObject,
                        { backgroundColor: theme.colors.overlay },
                        blurAnimatedStyle,
                      ]}
                    />
                  </AnimatedBlurView>
                </Pressable>

                <GestureDetector gesture={panGesture}>
                  <Animated.View
                    style={[
                      StyleSheet.absoluteFillObject,
                      styles.zoomContainer,
                      { width: SCREEN_WIDTH, height: SCREEN_HEIGHT },
                      { pointerEvents: 'box-none' },
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
                  style={StyleSheet.absoluteFillObject}
                  onPress={handleDismiss}
                  hitSlop={0}
                >
                  <AnimatedBlurView
                    intensity={80}
                    tint={theme.isDark ? 'dark' : 'light'}
                    style={[StyleSheet.absoluteFillObject, blurAnimatedStyle]}
                  >
                    <Animated.View
                      style={[
                        StyleSheet.absoluteFillObject,
                        { backgroundColor: theme.colors.overlay },
                        blurAnimatedStyle,
                      ]}
                    />
                  </AnimatedBlurView>
                </Pressable>

                <GestureDetector gesture={panGesture}>
                  <Animated.View
                    style={[
                      StyleSheet.absoluteFillObject,
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
    position: 'relative',
    overflow: 'hidden',
    justifyContent: 'center',
    alignItems: 'center',
  },
  modalContainer: {
    ...Platform.select({
      web: {
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: Z_INDEX.MODAL,
        justifyContent: 'center',
        alignItems: 'center',
      },
      default: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'transparent',
      },
    }),
  },
  zoomContainer: {
    justifyContent: 'center',
    alignItems: 'center',
  },
});

export default ZoomableAvatar;
