import React, { memo } from 'react';
import { View, StyleSheet } from 'react-native';
import Animated, {
  useAnimatedStyle,
  interpolate,
  interpolateColor,
  Extrapolation,
  type SharedValue,
} from 'react-native-reanimated';

import { useTheme } from '@/hooks/useTheme';
import { DOT_SIZE, DOT_ACTIVE_WIDTH, DOT_GAP } from './constants';

interface OnboardingDotsProps {
  count: number;
  scrollProgress: SharedValue<number>;
}

const OnboardingDots: React.FC<OnboardingDotsProps> = ({ count, scrollProgress }) => {
  const theme = useTheme();

  return (
    <View style={styles.container}>
      {Array.from({ length: count }, (_, i) => (
        <Dot
          key={i}
          index={i}
          scrollProgress={scrollProgress}
          activeColor={theme.colors.primary}
          inactiveColor={theme.colors.borderLight}
        />
      ))}
    </View>
  );
};

interface DotProps {
  index: number;
  scrollProgress: SharedValue<number>;
  activeColor: string;
  inactiveColor: string;
}

const Dot: React.FC<DotProps> = memo(({ index, scrollProgress, activeColor, inactiveColor }) => {
  const dotStyle = useAnimatedStyle(() => {
    const progress = scrollProgress.value;

    const width = interpolate(
      progress,
      [index - 1, index, index + 1],
      [DOT_SIZE, DOT_ACTIVE_WIDTH, DOT_SIZE],
      Extrapolation.CLAMP,
    );

    const opacity = interpolate(
      progress,
      [index - 1, index, index + 1],
      [0.4, 1, 0.4],
      Extrapolation.CLAMP,
    );

    const backgroundColor = interpolateColor(
      progress,
      [index - 1, index, index + 1],
      [inactiveColor, activeColor, inactiveColor],
    );

    return { width, opacity, backgroundColor };
  });

  return <Animated.View style={[styles.dot, dotStyle]} />;
});

Dot.displayName = 'Dot';

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: DOT_GAP,
  },
  dot: {
    height: DOT_SIZE,
    borderRadius: DOT_SIZE / 2,
  },
});

export default memo(OnboardingDots);
