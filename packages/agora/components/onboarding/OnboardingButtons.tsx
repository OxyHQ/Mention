import React, { memo, useCallback } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import Animated, {
  useAnimatedStyle,
  interpolate,
  Extrapolation,
  type SharedValue,
} from 'react-native-reanimated';

import { useTheme } from '@/hooks/useTheme';
import OnboardingDots from './OnboardingDots';

interface OnboardingButtonsProps {
  totalSteps: number;
  scrollProgress: SharedValue<number>;
  onNext: () => void;
  onBack: () => void;
  onDone: () => void;
}

const OnboardingButtons: React.FC<OnboardingButtonsProps> = ({
  totalSteps,
  scrollProgress,
  onNext,
  onBack,
  onDone,
}) => {
  const theme = useTheme();
  const lastIndex = totalSteps - 1;

  const backStyle = useAnimatedStyle(() => ({
    opacity: interpolate(
      scrollProgress.value,
      [0, 0.5],
      [0, 1],
      Extrapolation.CLAMP,
    ),
  }));

  const handlePrimary = useCallback(() => {
    const currentPage = Math.round(scrollProgress.value);
    if (currentPage >= lastIndex) {
      onDone();
    } else {
      onNext();
    }
  }, [scrollProgress, lastIndex, onNext, onDone]);

  return (
    <View style={styles.container}>
      <View style={styles.bottomRow}>
        <Animated.View style={backStyle}>
          <Pressable onPress={onBack} style={styles.backButton} hitSlop={8}>
            <Text style={[styles.backText, { color: theme.colors.textSecondary }]}>Back</Text>
          </Pressable>
        </Animated.View>

        <OnboardingDots count={totalSteps} scrollProgress={scrollProgress} />

        <Pressable
          onPress={handlePrimary}
          style={[styles.primaryButton, { backgroundColor: theme.colors.primary }]}
        >
          <PrimaryButtonLabel
            scrollProgress={scrollProgress}
            lastIndex={lastIndex}
            textColor={theme.colors.onPrimary ?? '#1C1C1E'}
          />
        </Pressable>
      </View>
    </View>
  );
};

const PrimaryButtonLabel: React.FC<{
  scrollProgress: SharedValue<number>;
  lastIndex: number;
  textColor: string;
}> = memo(({ scrollProgress, lastIndex, textColor }) => {
  const nextStyle = useAnimatedStyle(() => ({
    opacity: interpolate(
      scrollProgress.value,
      [lastIndex - 1, lastIndex],
      [1, 0],
      Extrapolation.CLAMP,
    ),
  }));

  const doneStyle = useAnimatedStyle(() => ({
    opacity: interpolate(
      scrollProgress.value,
      [lastIndex - 1, lastIndex],
      [0, 1],
      Extrapolation.CLAMP,
    ),
  }));

  return (
    <View>
      <Animated.Text style={[styles.primaryText, { color: textColor }, nextStyle]}>
        Next
      </Animated.Text>
      <Animated.Text style={[styles.primaryText, styles.overlayText, { color: textColor }, doneStyle]}>
        Start
      </Animated.Text>
    </View>
  );
});

PrimaryButtonLabel.displayName = 'PrimaryButtonLabel';

const styles = StyleSheet.create({
  container: {
    width: '100%',
  },
  bottomRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  backButton: {
    paddingVertical: 8,
    paddingHorizontal: 12,
  },
  backText: {
    fontSize: 13,
    fontWeight: '500',
  },
  primaryButton: {
    paddingVertical: 10,
    paddingHorizontal: 20,
    borderRadius: 20,
    minWidth: 100,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryText: {
    fontSize: 14,
    fontWeight: '600',
    textAlign: 'center',
  },
  overlayText: {
    position: 'absolute',
    left: 0,
    right: 0,
    textAlign: 'center',
  },
});

export default memo(OnboardingButtons);
