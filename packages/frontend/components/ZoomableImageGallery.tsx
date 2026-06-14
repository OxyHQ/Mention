import React, { useCallback, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  Modal,
  Platform,
  ScrollView,
  useWindowDimensions,
  ViewStyle,
  NativeSyntheticEvent,
  NativeScrollEvent,
} from 'react-native';
import { Image } from 'expo-image';
import { BlurView } from 'expo-blur';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
  withTiming,
  runOnJS,
  Easing,
} from 'react-native-reanimated';
import {
  GestureHandlerRootView,
  Gesture,
  GestureDetector,
} from 'react-native-gesture-handler';
import { useTheme } from '@oxyhq/bloom/theme';
import { Portal } from '@oxyhq/bloom/portal';
import { Z_INDEX } from '@/lib/constants';
import { MEDIA_CARD_RADIUS } from '@/utils/composeUtils';
import {
  getAspectRatio,
  fetchAspectRatio,
  DEFAULT_ASPECT_RATIO,
} from '@/utils/imageAspectRatioCache';
import type { MeasuredRect } from '@/components/Post/Attachments/PostAttachmentMedia';

const AnimatedBlurView = Animated.createAnimatedComponent(BlurView);
const AnimatedImage = Animated.createAnimatedComponent(Image);

/** Fraction of the screen the fitted "big" image is allowed to occupy. */
const FIT_FRACTION = 0.9;
/** Drag distance (as a fraction of screen height) that fully fades the backdrop. */
const MAX_DRAG_FRACTION = 0.3;
/** Drag distance (as a fraction of screen height) over which scale floors out. */
const SCALE_DRAG_FRACTION = 0.5;
/** Minimum scale reached while dragging to dismiss. */
const MIN_DRAG_SCALE = 0.5;
/** Drag distance (as a fraction of screen height) past which a drag dismisses. */
const DISMISS_FRACTION = 0.15;
/** Axis-decision threshold (px): the vertical dismiss pan only claims drags past this. */
const AXIS_DECISION_OFFSET = 12;

const OPEN_DURATION_WEB = 300;
const CLOSE_DURATION_WEB = 280;
const OPACITY_DURATION = 200;

const OPEN_SPRING = { damping: 18, stiffness: 400, mass: 0.4 } as const;
const CLOSE_SPRING = { damping: 22, stiffness: 450, mass: 0.35 } as const;
const SNAP_BACK_SPRING = { damping: 20, stiffness: 400, mass: 0.4 } as const;

// Web-only interaction hints. Both `userSelect` and `cursor` are declared on
// RN's `ViewStyle`; `cursor` only accepts `'auto' | 'pointer'`, so the zoom
// surfaces use `'pointer'` (they are tap-to-dismiss).
const webPointerStyle: ViewStyle | null = Platform.OS === 'web'
  ? { userSelect: 'none', cursor: 'pointer' }
  : null;

export interface GalleryImage {
  /** Source URI rendered both as the post thumbnail and the zoomed image. */
  uri: string;
}

export interface ZoomableImageGalleryHandle {
  /**
   * Open the gallery at `index` within `images`, animating the zoom from the
   * tapped thumbnail's measured screen rect (when provided).
   */
  open: (images: GalleryImage[], index: number, rect?: MeasuredRect) => void;
}

interface FittedSize {
  width: number;
  height: number;
}

/**
 * Fullscreen, swipeable image viewer that replicates the profile avatar's
 * measured-origin zoom transition (`ZoomableAvatar`) for rectangular post media:
 *
 * - Open/close feel is identical to the avatar (same spring configs, web
 *   timing/easing, blur backdrop, Portal-on-web / Modal-on-native split, and the
 *   measure-origin technique).
 * - The OPENING (tapped) image animates from its measured rect to a centered,
 *   aspect-ratio-preserving fit within {@link FIT_FRACTION} of the screen. Once
 *   the open animation settles, a horizontal paging `ScrollView` mounts seeded at
 *   the tapped index so the user can swipe between every image in the post.
 * - Gesture disambiguation: the pager owns horizontal swipes; a vertical-only
 *   `Gesture.Pan` (`activeOffsetY` + `failOffsetX`) owns drag-to-dismiss, so the
 *   two never fight.
 */
const ZoomableImageGalleryInner = React.forwardRef<ZoomableImageGalleryHandle>((_, ref) => {
  const theme = useTheme();
  const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = useWindowDimensions();

  const [isOpen, setIsOpen] = useState(false);
  // Once true, the swipeable pager is mounted and the single open-image hidden.
  const [pagerReady, setPagerReady] = useState(false);
  const [images, setImages] = useState<GalleryImage[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  // Aspect ratio of the OPENING image (drives the open-animation fit box).
  const [openRatio, setOpenRatio] = useState<number>(DEFAULT_ASPECT_RATIO);
  // Per-image aspect ratios for the pager pages (index-aligned with `images`).
  const [pageRatios, setPageRatios] = useState<Record<number, number>>({});

  const scale = useSharedValue(1);
  const translateX = useSharedValue(0);
  const translateY = useSharedValue(0);
  const opacity = useSharedValue(0);

  // Origin (offset from screen center) of the tapped image.
  const originX = useSharedValue(0);
  const originY = useSharedValue(0);

  const startX = useSharedValue(0);
  const startY = useSharedValue(0);
  // Per-drag baseline captured at pan start (transient).
  const startScale = useSharedValue(1);
  // Persistent scale of the open-image at its thumbnail origin (thumbWidth /
  // fittedWidth). The open animation grows from this to 1; the close animation
  // shrinks back to it. Never overwritten by the drag gesture.
  const originScale = useSharedValue(1);

  const pagerRef = useRef<ScrollView>(null);
  // Latch the index the pager must land on once it has mounted + laid out.
  const pendingIndexRef = useRef(0);

  // Box the fitted image must fit inside.
  const fitBox = useMemo<FittedSize>(
    () => ({ width: SCREEN_WIDTH * FIT_FRACTION, height: SCREEN_HEIGHT * FIT_FRACTION }),
    [SCREEN_WIDTH, SCREEN_HEIGHT]
  );

  // Compute the largest width/height for `ratio` that fits inside `fitBox`
  // without cropping (contain).
  const fitForRatio = useCallback((ratio: number): FittedSize => {
    const safeRatio = ratio > 0 && Number.isFinite(ratio) ? ratio : DEFAULT_ASPECT_RATIO;
    let width = fitBox.width;
    let height = width / safeRatio;
    if (height > fitBox.height) {
      height = fitBox.height;
      width = height * safeRatio;
    }
    return { width, height };
  }, [fitBox]);

  const openFit = useMemo(() => fitForRatio(openRatio), [fitForRatio, openRatio]);

  const ensureRatio = useCallback((index: number, uri: string) => {
    const cached = getAspectRatio(uri);
    if (cached !== undefined) {
      setPageRatios((prev) => (prev[index] === cached ? prev : { ...prev, [index]: cached }));
      return;
    }
    void fetchAspectRatio(uri).then((ratio) => {
      setPageRatios((prev) => (prev[index] === ratio ? prev : { ...prev, [index]: ratio }));
    });
  }, []);

  const handleDismiss = useCallback(() => {
    // Always animate the (possibly already-revealed) pager back through the
    // single open-image, which shrinks to the thumbnail footprint at `startScale`.
    setPagerReady(false);
    if (Platform.OS === 'web') {
      const duration = CLOSE_DURATION_WEB;
      const easing = Easing.in(Easing.cubic);
      scale.value = withTiming(originScale.value, { duration, easing });
      translateX.value = withTiming(originX.value, { duration, easing });
      translateY.value = withTiming(originY.value, { duration, easing });
      opacity.value = withTiming(0, { duration, easing });
      setTimeout(() => {
        setIsOpen(false);
        scale.value = 1;
        translateX.value = 0;
        translateY.value = 0;
        opacity.value = 0;
      }, duration + 20);
    } else {
      scale.value = withSpring(originScale.value, CLOSE_SPRING);
      translateX.value = withSpring(originX.value, CLOSE_SPRING);
      translateY.value = withSpring(originY.value, CLOSE_SPRING);
      opacity.value = withTiming(0, { duration: OPACITY_DURATION });
      setTimeout(() => {
        setIsOpen(false);
        scale.value = 1;
        translateX.value = 0;
        translateY.value = 0;
        opacity.value = 0;
      }, CLOSE_DURATION_WEB);
    }
  }, [opacity, originScale, originX, originY, scale, translateX, translateY]);

  // Reveal the swipeable pager once the open animation has settled. The index it
  // lands on is held in `pendingIndexRef` (set synchronously in `open`) and
  // applied in `onPagerLayout`.
  const revealPager = useCallback(() => {
    setPagerReady(true);
  }, []);

  const open = useCallback(
    (nextImages: GalleryImage[], index: number, rect?: MeasuredRect) => {
      if (isOpen || nextImages.length === 0) return;
      const safeIndex = Math.min(Math.max(index, 0), nextImages.length - 1);
      const target = nextImages[safeIndex];
      const ratio = getAspectRatio(target.uri) ?? DEFAULT_ASPECT_RATIO;

      setImages(nextImages);
      setActiveIndex(safeIndex);
      setOpenRatio(ratio);
      setPageRatios({ [safeIndex]: ratio });
      pendingIndexRef.current = safeIndex;

      // Resolve the opening ratio if it was not yet cached, then re-fit.
      if (getAspectRatio(target.uri) === undefined) {
        void fetchAspectRatio(target.uri).then((resolved) => {
          setOpenRatio(resolved);
          setPageRatios((prev) => ({ ...prev, [safeIndex]: resolved }));
        });
      }

      // The open-image box is rendered at its FINAL fitted size; the open
      // animation grows it from the thumbnail's footprint (scale < 1) up to 1,
      // mirroring the avatar's small→big scale. The initial scale is the ratio
      // of the thumbnail width to the fitted width.
      const fitted = fitForRatio(ratio);
      const centerX = SCREEN_WIDTH / 2;
      const centerY = SCREEN_HEIGHT / 2;
      if (rect && rect.width > 0) {
        originX.value = rect.x + rect.width / 2 - centerX;
        originY.value = rect.y + rect.height / 2 - centerY;
        originScale.value = rect.width / fitted.width;
      } else {
        originX.value = 0;
        originY.value = 0;
        originScale.value = 1;
      }

      setIsOpen(true);
      translateX.value = originX.value;
      translateY.value = originY.value;
      scale.value = originScale.value;
      opacity.value = 0;

      if (Platform.OS === 'web') {
        requestAnimationFrame(() => {
          const duration = OPEN_DURATION_WEB;
          const easing = Easing.out(Easing.cubic);
          scale.value = withTiming(1, { duration, easing });
          translateX.value = withTiming(0, { duration, easing });
          translateY.value = withTiming(0, { duration, easing });
          opacity.value = withTiming(1, { duration, easing });
          setTimeout(revealPager, duration);
        });
      } else {
        setTimeout(() => {
          scale.value = withSpring(1, OPEN_SPRING);
          translateX.value = withSpring(0, OPEN_SPRING);
          translateY.value = withSpring(0, OPEN_SPRING);
          opacity.value = withTiming(1, { duration: OPACITY_DURATION });
          setTimeout(revealPager, OPEN_DURATION_WEB);
        }, 0);
      }
    },
    [
      isOpen,
      SCREEN_WIDTH,
      SCREEN_HEIGHT,
      fitForRatio,
      opacity,
      originScale,
      originX,
      originY,
      revealPager,
      scale,
      translateX,
      translateY,
    ]
  );

  React.useImperativeHandle(ref, () => ({ open }), [open]);

  const panGesture = useMemo(
    () =>
      Gesture.Pan()
        .enabled(isOpen)
        // Only claim drags that are decided to be vertical; horizontal drags
        // fall through to the pager's ScrollView so swiping changes pages.
        .activeOffsetY([-AXIS_DECISION_OFFSET, AXIS_DECISION_OFFSET])
        .failOffsetX([-AXIS_DECISION_OFFSET, AXIS_DECISION_OFFSET])
        .onStart(() => {
          startX.value = translateX.value;
          startY.value = translateY.value;
          startScale.value = scale.value;
        })
        .onUpdate((event) => {
          translateX.value = startX.value + event.translationX;
          translateY.value = startY.value + event.translationY;
          const dragDistance = Math.sqrt(event.translationX ** 2 + event.translationY ** 2);
          const maxDrag = SCREEN_HEIGHT * MAX_DRAG_FRACTION;
          opacity.value = Math.max(0, 1 - dragDistance / maxDrag);
          const scaleReduction = Math.max(
            MIN_DRAG_SCALE,
            1 - dragDistance / (SCREEN_HEIGHT * SCALE_DRAG_FRACTION)
          );
          scale.value = startScale.value * scaleReduction;
        })
        .onEnd((event) => {
          const dragDistance = Math.sqrt(event.translationX ** 2 + event.translationY ** 2);
          if (dragDistance > SCREEN_HEIGHT * DISMISS_FRACTION) {
            runOnJS(handleDismiss)();
          } else {
            scale.value = withSpring(1, SNAP_BACK_SPRING);
            translateX.value = withSpring(0, SNAP_BACK_SPRING);
            translateY.value = withSpring(0, SNAP_BACK_SPRING);
            opacity.value = withTiming(1, { duration: OPACITY_DURATION });
          }
        }),
    [handleDismiss, isOpen, SCREEN_HEIGHT, opacity, scale, startScale, startX, startY, translateX, translateY]
  );

  const backdropStyle = useAnimatedStyle(() => ({ opacity: opacity.value }));

  // The single open-image animates from origin → fitted center.
  const openImageStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: translateX.value },
      { translateY: translateY.value },
      { scale: scale.value },
    ],
  }));

  // While dragging to dismiss, the whole pager follows the finger + fades.
  const pagerContainerStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform: [
      { translateX: translateX.value },
      { translateY: translateY.value },
      { scale: scale.value },
    ],
  }));

  const onPagerScrollEnd = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const offsetX = event.nativeEvent.contentOffset.x;
      const next = Math.round(offsetX / SCREEN_WIDTH);
      if (next !== activeIndex && next >= 0 && next < images.length) {
        setActiveIndex(next);
        const img = images[next];
        if (img) ensureRatio(next, img.uri);
      }
    },
    [activeIndex, ensureRatio, images, SCREEN_WIDTH]
  );

  // When the pager mounts, jump it to the open index without animation so the
  // swap from the open-image to the pager is seamless.
  const onPagerLayout = useCallback(() => {
    const idx = pendingIndexRef.current;
    if (idx > 0) {
      pagerRef.current?.scrollTo({ x: idx * SCREEN_WIDTH, animated: false });
    }
  }, [SCREEN_WIDTH]);

  const renderContent = () => (
    <GestureHandlerRootView style={styles.modalContainer}>
      <Pressable style={StyleSheet.absoluteFill} onPress={handleDismiss} hitSlop={0}>
        <AnimatedBlurView
          intensity={80}
          tint={theme.isDark ? 'dark' : 'light'}
          experimentalBlurMethod="dimezisBlurView"
          style={[StyleSheet.absoluteFill, backdropStyle]}
        >
          <Animated.View
            style={[StyleSheet.absoluteFill, { backgroundColor: theme.colors.overlay }, backdropStyle]}
          />
        </AnimatedBlurView>
      </Pressable>

      <GestureDetector gesture={panGesture}>
        <Animated.View
          style={[
            StyleSheet.absoluteFill,
            styles.zoomContainer,
            { width: SCREEN_WIDTH, height: SCREEN_HEIGHT },
          ]}
          pointerEvents="box-none"
        >
          {!pagerReady && (
            <Pressable onPress={handleDismiss} style={webPointerStyle}>
              <AnimatedImage
                source={{ uri: images[activeIndex]?.uri }}
                contentFit="contain"
                style={[
                  { width: openFit.width, height: openFit.height, borderRadius: MEDIA_CARD_RADIUS },
                  openImageStyle,
                ]}
                transition={0}
                {...(Platform.OS === 'web' ? { draggable: false } : {})}
              />
            </Pressable>
          )}

          {pagerReady && (
            <Animated.View style={[StyleSheet.absoluteFill, pagerContainerStyle]}>
              <ScrollView
                ref={pagerRef}
                horizontal
                pagingEnabled
                showsHorizontalScrollIndicator={false}
                contentOffset={{ x: pendingIndexRef.current * SCREEN_WIDTH, y: 0 }}
                onLayout={onPagerLayout}
                onMomentumScrollEnd={onPagerScrollEnd}
                scrollEventThrottle={16}
                style={StyleSheet.absoluteFill}
              >
                {images.map((img, idx) => {
                  const ratio = pageRatios[idx] ?? getAspectRatio(img.uri) ?? DEFAULT_ASPECT_RATIO;
                  const fit = fitForRatio(ratio);
                  return (
                    <Pressable
                      key={`${img.uri}-${idx}`}
                      onPress={handleDismiss}
                      style={[styles.page, { width: SCREEN_WIDTH, height: SCREEN_HEIGHT }, webPointerStyle]}
                    >
                      <Image
                        source={{ uri: img.uri }}
                        contentFit="contain"
                        style={{ width: fit.width, height: fit.height, borderRadius: MEDIA_CARD_RADIUS }}
                        transition={0}
                        {...(Platform.OS === 'web' ? { draggable: false } : {})}
                      />
                    </Pressable>
                  );
                })}
              </ScrollView>
            </Animated.View>
          )}

          {pagerReady && images.length > 1 && (
            <Animated.View style={[styles.indicatorWrap, backdropStyle]} pointerEvents="none">
              <View style={styles.counterPill}>
                <Text style={styles.counterText}>{`${activeIndex + 1} / ${images.length}`}</Text>
              </View>
              <View style={styles.dotsRow}>
                {images.map((img, idx) => (
                  <View
                    key={`dot-${img.uri}-${idx}`}
                    style={[styles.dot, idx === activeIndex ? styles.dotActive : styles.dotInactive]}
                  />
                ))}
              </View>
            </Animated.View>
          )}
        </Animated.View>
      </GestureDetector>
    </GestureHandlerRootView>
  );

  if (!isOpen) return null;

  if (Platform.OS === 'web') {
    return <Portal>{renderContent()}</Portal>;
  }

  return (
    <Modal
      visible={isOpen}
      transparent
      animationType="none"
      statusBarTranslucent={Platform.OS === 'android'}
      onRequestClose={handleDismiss}
      hardwareAccelerated={Platform.OS === 'android'}
    >
      {renderContent()}
    </Modal>
  );
});

ZoomableImageGalleryInner.displayName = 'ZoomableImageGallery';

export const ZoomableImageGallery = ZoomableImageGalleryInner;

const styles = StyleSheet.create({
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
    ...Platform.select({
      web: { userSelect: 'none' },
      default: {},
    }),
  },
  page: {
    justifyContent: 'center',
    alignItems: 'center',
  },
  indicatorWrap: {
    position: 'absolute',
    bottom: 48,
    left: 0,
    right: 0,
    alignItems: 'center',
    gap: 10,
  },
  counterPill: {
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderRadius: 999,
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  counterText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '600',
  },
  dotsRow: {
    flexDirection: 'row',
    gap: 6,
  },
  dot: {
    width: 7,
    height: 7,
    borderRadius: 999,
  },
  dotActive: {
    backgroundColor: '#fff',
  },
  dotInactive: {
    backgroundColor: 'rgba(255,255,255,0.4)',
  },
});

export default ZoomableImageGallery;
