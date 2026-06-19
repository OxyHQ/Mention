import { useEffect, useRef, useState } from 'react';
import { Text, View } from 'react-native';
import Animated, { LayoutAnimationConfig, useReducedMotion } from 'react-native-reanimated';

import { useTheme } from '@oxyhq/bloom/theme';
import {
  countEnterFromAbove,
  countEnterFromBelow,
  countExitDown,
  countExitUp,
} from '@/lib/animations/entryExit';
import { formatCompactNumber } from '@/utils/formatNumber';

/**
 * Roll only when the compact label keeps the same shape. Boundary changes like
 * 999 -> 1K snap because the text width and suffix change.
 */
function shouldAnimateCountRoll(isLiked: boolean, likeCount: number): boolean {
  const prev = isLiked ? likeCount - 1 : likeCount + 1;
  return formatCompactNumber(prev) === formatCompactNumber(likeCount);
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
  const shouldRoll = shouldAnimateCountRoll(isLiked, likeCount);

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

  const currentCountAnimation =
    shouldAnimate && shouldRoll
      ? isLiked
        ? countEnterFromBelow
        : countEnterFromAbove
      : undefined;
  const previousCountAnimation =
    shouldAnimate && shouldRoll
      ? isLiked
        ? countExitUp
        : countExitDown
      : undefined;

  const likeColor = theme.colors.error;
  const defaultColor = theme.colors.textSecondary;
  const fontSize = big ? 15 : 13;

  return (
    <LayoutAnimationConfig skipEntering skipExiting>
      {likeCount > 0 ? (
        <View style={{ justifyContent: 'center' }}>
          <Animated.View entering={currentCountAnimation} key={key}>
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
              entering={previousCountAnimation}
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
