import React, { memo } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import Animated, {
  useAnimatedStyle,
  interpolate,
  Extrapolation,
} from 'react-native-reanimated';
import LottieView from 'lottie-react-native';

import { useTheme } from '@/hooks/useTheme';
import { ONBOARDING_ANIMATION } from './constants';
import type { OnboardingPageProps } from './types';

const LOTTIE_SIZE = 180;

const OnboardingPage: React.FC<OnboardingPageProps> = ({
  step,
  index,
  scrollProgress,
  pageWidth,
  reduceMotion,
  onContentHeightMeasured,
}) => {
  const theme = useTheme();

  const lottieContainerStyle = useAnimatedStyle(() => {
    const progress = scrollProgress.value;

    if (reduceMotion) {
      return {
        opacity: interpolate(
          progress,
          [index - 0.5, index, index + 0.5],
          [0, 1, 0],
          Extrapolation.CLAMP,
        ),
      };
    }

    const translateX = interpolate(
      progress,
      [index - 1, index, index + 1],
      [pageWidth * ONBOARDING_ANIMATION.PARALLAX_FACTOR, 0, -pageWidth * ONBOARDING_ANIMATION.PARALLAX_FACTOR],
      Extrapolation.CLAMP,
    );

    const scale = interpolate(
      progress,
      [index - 1, index, index + 1],
      [ONBOARDING_ANIMATION.SCALE_INACTIVE, ONBOARDING_ANIMATION.SCALE_ACTIVE, ONBOARDING_ANIMATION.SCALE_INACTIVE],
      Extrapolation.CLAMP,
    );

    const opacity = interpolate(
      progress,
      [index - 0.6, index, index + 0.6],
      [0, 1, 0],
      Extrapolation.CLAMP,
    );

    return {
      transform: [{ translateX }, { scale }],
      opacity,
    };
  });

  const textStyle = useAnimatedStyle(() => {
    const progress = scrollProgress.value;

    if (reduceMotion) {
      return {
        opacity: interpolate(
          progress,
          [index - 0.5, index, index + 0.5],
          [0, 1, 0],
          Extrapolation.CLAMP,
        ),
      };
    }

    const translateX = interpolate(
      progress,
      [index - 1, index, index + 1],
      [pageWidth * 0.1, 0, -pageWidth * 0.1],
      Extrapolation.CLAMP,
    );

    const opacity = interpolate(
      progress,
      [index - 0.6, index, index + 0.6],
      [0, 1, 0],
      Extrapolation.CLAMP,
    );

    return {
      transform: [{ translateX }],
      opacity,
    };
  });

  return (
    <View style={[styles.page, { width: pageWidth }]}>
      <View
        style={styles.contentMeasure}
        onLayout={(e) => onContentHeightMeasured?.(index, e.nativeEvent.layout.height)}
      >
        <Animated.View style={[styles.lottieContainer, lottieContainerStyle]}>
          <LottieView
            source={step.lottieSource}
            autoPlay
            loop
            style={styles.lottie}
            webStyle={{ width: LOTTIE_SIZE, height: LOTTIE_SIZE }}
          />
        </Animated.View>

        <Animated.View style={[styles.textContainer, textStyle]}>
          <Text style={[styles.title, { color: theme.colors.text }]}>
            {step.title}
          </Text>
          <Text style={[styles.subtitle, { color: theme.colors.textSecondary }]}>
            {step.subtitle}
          </Text>
        </Animated.View>
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  page: {
    alignItems: 'center',
    paddingHorizontal: 32,
  },
  contentMeasure: {
    alignItems: 'center',
  },
  lottieContainer: {
    width: LOTTIE_SIZE,
    height: LOTTIE_SIZE,
    marginBottom: 32,
  },
  lottie: {
    width: '100%',
    height: '100%',
  },
  textContainer: {
    alignItems: 'center',
    paddingHorizontal: 16,
  },
  title: {
    fontSize: 28,
    fontWeight: '700',
    textAlign: 'center',
    marginBottom: 12,
    letterSpacing: -0.3,
  },
  subtitle: {
    fontSize: 16,
    textAlign: 'center',
    lineHeight: 24,
  },
});

export default memo(OnboardingPage);
