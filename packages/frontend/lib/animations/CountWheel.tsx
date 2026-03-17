import { useEffect, useRef, useState } from 'react';
import { Text, View } from 'react-native';
import Animated, {
  Easing,
  LayoutAnimationConfig,
  useReducedMotion,
  withTiming,
} from 'react-native-reanimated';

import { useTheme } from '@oxyhq/bloom/theme';
import { formatCompactNumber } from '@/utils/formatNumber';

const animationConfig = {
  duration: 400,
  easing: Easing.out(Easing.cubic),
};

function EnteringUp() {
  'worklet';
  const animations = {
    opacity: withTiming(1, animationConfig),
    transform: [{ translateY: withTiming(0, animationConfig) }],
  };
  const initialValues = {
    opacity: 0,
    transform: [{ translateY: 18 }],
  };
  return { animations, initialValues };
}

function EnteringDown() {
  'worklet';
  const animations = {
    opacity: withTiming(1, animationConfig),
    transform: [{ translateY: withTiming(0, animationConfig) }],
  };
  const initialValues = {
    opacity: 0,
    transform: [{ translateY: -18 }],
  };
  return { animations, initialValues };
}

function ExitingUp() {
  'worklet';
  const animations = {
    opacity: withTiming(0, animationConfig),
    transform: [{ translateY: withTiming(-18, animationConfig) }],
  };
  const initialValues = {
    opacity: 1,
    transform: [{ translateY: 0 }],
  };
  return { animations, initialValues };
}

function ExitingDown() {
  'worklet';
  const animations = {
    opacity: withTiming(0, animationConfig),
    transform: [{ translateY: withTiming(18, animationConfig) }],
  };
  const initialValues = {
    opacity: 1,
    transform: [{ translateY: 0 }],
  };
  return { animations, initialValues };
}

/**
 * Decides whether the count wheel should roll or just snap.
 * Roll when the formatted count actually changes (e.g., 999 -> 1K should snap, 5 -> 6 should roll).
 */
function decideShouldRoll(isLiked: boolean, likeCount: number): boolean {
  const prev = isLiked ? likeCount - 1 : likeCount + 1;
  return formatCompactNumber(prev) !== formatCompactNumber(likeCount);
}

export function CountWheel({
  likeCount,
  big,
  isLiked,
  hasBeenToggled,
}: {
  likeCount: number;
  big?: boolean;
  isLiked: boolean;
  hasBeenToggled: boolean;
}) {
  const theme = useTheme();
  const shouldAnimate = !useReducedMotion() && hasBeenToggled;
  const shouldRoll = !decideShouldRoll(isLiked, likeCount);

  const [key, setKey] = useState(0);
  const [prevCount, setPrevCount] = useState(likeCount);
  const prevIsLiked = useRef(isLiked);

  const formattedCount = formatCompactNumber(likeCount);
  const formattedPrevCount = formatCompactNumber(prevCount);

  useEffect(() => {
    if (isLiked === prevIsLiked.current) {
      return;
    }

    const newPrevCount = isLiked ? likeCount - 1 : likeCount + 1;
    setKey((prev) => prev + 1);
    setPrevCount(newPrevCount);
    prevIsLiked.current = isLiked;
  }, [isLiked, likeCount]);

  const enteringAnimation =
    shouldAnimate && shouldRoll
      ? isLiked
        ? EnteringUp
        : EnteringDown
      : undefined;
  const exitingAnimation =
    shouldAnimate && shouldRoll
      ? isLiked
        ? ExitingUp
        : ExitingDown
      : undefined;

  const likeColor = theme.colors.error;
  const defaultColor = theme.colors.textSecondary;
  const fontSize = big ? 15 : 13;

  return (
    <LayoutAnimationConfig skipEntering skipExiting>
      {likeCount > 0 ? (
        <View style={{ justifyContent: 'center' }}>
          <Animated.View entering={enteringAnimation} key={key}>
            <Text
              style={{
                fontSize,
                userSelect: 'none',
                color: isLiked ? likeColor : defaultColor,
                fontWeight: isLiked ? '600' : '400',
              }}>
              {formattedCount}
            </Text>
          </Animated.View>
          {shouldAnimate && (likeCount > 1 || !isLiked) ? (
            <Animated.View
              entering={exitingAnimation}
              key={key + 2}
              style={{ position: 'absolute', width: 50, opacity: 0 }}
              aria-disabled={true}>
              <Text
                style={{
                  fontSize,
                  userSelect: 'none',
                  color: isLiked ? likeColor : defaultColor,
                  fontWeight: isLiked ? '600' : '400',
                }}>
                {formattedPrevCount}
              </Text>
            </Animated.View>
          ) : null}
        </View>
      ) : null}
    </LayoutAnimationConfig>
  );
}
