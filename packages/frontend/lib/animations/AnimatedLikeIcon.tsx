import { useEffect } from 'react';
import { View } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withSequence,
  withTiming,
} from 'react-native-reanimated';

import { HeartIcon, HeartIconActive } from '@/assets/icons/heart-icon';
import { useTheme } from '@oxyhq/bloom/theme';

const LIKE_ANIMATION_MS = 300;
const easeOut = Easing.bezier(0.16, 1, 0.3, 1);
const ringTiming = {
  duration: LIKE_ANIMATION_MS,
  easing: easeOut,
};

export function AnimatedLikeIcon({
  isLiked,
  big,
  hasBeenToggled,
}: {
  isLiked: boolean;
  big?: boolean;
  hasBeenToggled: boolean;
}) {
  const theme = useTheme();
  const size = big ? 22 : 18;
  const likeColor = theme.colors.error;
  const reduceMotion = useReducedMotion();
  const shouldAnimate = !reduceMotion && hasBeenToggled;
  const iconScale = useSharedValue(1);
  const outerRingOpacity = useSharedValue(0);
  const outerRingScale = useSharedValue(0);
  const innerRingOpacity = useSharedValue(0);
  const innerRingScale = useSharedValue(0);

  useEffect(() => {
    if (!isLiked || !shouldAnimate) {
      iconScale.value = 1;
      outerRingOpacity.value = 0;
      outerRingScale.value = 0;
      innerRingOpacity.value = 0;
      innerRingScale.value = 0;
      return;
    }

    iconScale.value = withSequence(
      withTiming(0.7, { duration: 30 }),
      withTiming(1.2, { duration: 90, easing: easeOut }),
      withTiming(1, { duration: 180, easing: easeOut }),
    );
    outerRingOpacity.value = withSequence(
      withTiming(0.4, { duration: 30 }),
      withDelay(255, withTiming(0, { duration: 15 })),
    );
    outerRingScale.value = withTiming(1.5, ringTiming);
    innerRingOpacity.value = withSequence(
      withTiming(1, { duration: 30 }),
      withDelay(255, withTiming(0, { duration: 15 })),
    );
    innerRingScale.value = withSequence(
      withTiming(0, { duration: 120 }),
      withTiming(1.5, { duration: 180, easing: easeOut }),
    );
  }, [
    iconScale,
    innerRingOpacity,
    innerRingScale,
    isLiked,
    outerRingOpacity,
    outerRingScale,
    shouldAnimate,
  ]);

  const iconStyle = useAnimatedStyle(() => ({
    transform: [{ scale: iconScale.value }],
  }));

  const outerRingStyle = useAnimatedStyle(() => ({
    opacity: outerRingOpacity.value,
    transform: [{ scale: outerRingScale.value }],
  }));

  const innerRingStyle = useAnimatedStyle(() => ({
    opacity: innerRingOpacity.value,
    transform: [{ scale: innerRingScale.value }],
  }));

  return (
    <View>
      {isLiked ? (
        <Animated.View style={iconStyle}>
          <HeartIconActive color={likeColor} size={size} />
        </Animated.View>
      ) : (
        <HeartIcon
          className="text-muted-foreground"
          size={size}
        />
      )}
      {isLiked && shouldAnimate ? (
        <>
          <Animated.View
            style={[
              {
                position: 'absolute',
                backgroundColor: likeColor,
                top: 0,
                left: 0,
                width: size,
                height: size,
                zIndex: -1,
                pointerEvents: 'none',
                borderRadius: size / 2,
              },
              outerRingStyle,
            ]}
          />
          <Animated.View
            style={[
              {
                position: 'absolute',
                backgroundColor: theme.colors.background,
                top: 0,
                left: 0,
                width: size,
                height: size,
                zIndex: -1,
                pointerEvents: 'none',
                borderRadius: size / 2,
              },
              innerRingStyle,
            ]}
          />
        </>
      ) : null}
    </View>
  );
}
