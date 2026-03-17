import { View } from 'react-native';
import Animated, {
  Keyframe,
  LayoutAnimationConfig,
  useReducedMotion,
} from 'react-native-reanimated';

import { HeartIcon, HeartIconActive } from '@/assets/icons/heart-icon';
import { useTheme } from '@oxyhq/bloom/theme';

const keyframe = new Keyframe({
  0: {
    transform: [{ scale: 1 }],
  },
  10: {
    transform: [{ scale: 0.7 }],
  },
  40: {
    transform: [{ scale: 1.2 }],
  },
  100: {
    transform: [{ scale: 1 }],
  },
});

const circle1Keyframe = new Keyframe({
  0: {
    opacity: 0,
    transform: [{ scale: 0 }],
  },
  10: {
    opacity: 0.4,
  },
  40: {
    transform: [{ scale: 1.5 }],
  },
  95: {
    opacity: 0.4,
  },
  100: {
    opacity: 0,
    transform: [{ scale: 1.5 }],
  },
});

const circle2Keyframe = new Keyframe({
  0: {
    opacity: 0,
    transform: [{ scale: 0 }],
  },
  10: {
    opacity: 1,
  },
  40: {
    transform: [{ scale: 0 }],
  },
  95: {
    opacity: 1,
  },
  100: {
    opacity: 0,
    transform: [{ scale: 1.5 }],
  },
});

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
  const shouldAnimate = !useReducedMotion() && hasBeenToggled;

  return (
    <View>
      <LayoutAnimationConfig skipEntering>
        {isLiked ? (
          <Animated.View
            entering={shouldAnimate ? keyframe.duration(300) : undefined}>
            <HeartIconActive color={likeColor} size={size} />
          </Animated.View>
        ) : (
          <HeartIcon
            className="text-muted-foreground"
            size={size}
            style={{ pointerEvents: 'none' } as any}
          />
        )}
        {isLiked && shouldAnimate ? (
          <>
            <Animated.View
              entering={circle1Keyframe.duration(300)}
              style={{
                position: 'absolute',
                backgroundColor: likeColor,
                top: 0,
                left: 0,
                width: size,
                height: size,
                zIndex: -1,
                pointerEvents: 'none',
                borderRadius: size / 2,
              }}
            />
            <Animated.View
              entering={circle2Keyframe.duration(300)}
              style={{
                position: 'absolute',
                backgroundColor: theme.colors.background,
                top: 0,
                left: 0,
                width: size,
                height: size,
                zIndex: -1,
                pointerEvents: 'none',
                borderRadius: size / 2,
              }}
            />
          </>
        ) : null}
      </LayoutAnimationConfig>
    </View>
  );
}
