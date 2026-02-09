import React, { useCallback, useState, useEffect, memo } from 'react';
import {
  View,
  Text,
  Pressable,
  StyleSheet,
  AccessibilityInfo,
  Platform,
} from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedScrollHandler,
  useAnimatedRef,
  useAnimatedStyle,
  interpolate,
  Extrapolation,
  scrollTo,
  runOnJS,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuth } from '@oxyhq/services';

import { useTheme } from '@/hooks/useTheme';
import OnboardingPage from './OnboardingPage';
import OnboardingButtons from './OnboardingButtons';
import { useOnboardingProgress } from './useOnboardingProgress';
import { ONBOARDING_STEPS } from './constants';

interface OnboardingScreenProps {
  onComplete: () => void;
}

const OnboardingScreen: React.FC<OnboardingScreenProps> = ({ onComplete }) => {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { isAuthenticated } = useAuth();

  const scrollRef = useAnimatedRef<Animated.ScrollView>();
  const scrollProgress = useSharedValue(0);
  const pageWidthValue = useSharedValue(0);
  const [pageWidth, setPageWidth] = useState(0);

  const { progress, loaded, updateStep, markCompleted, markSkipped } =
    useOnboardingProgress(isAuthenticated);

  const [reduceMotion, setReduceMotion] = useState(false);

  useEffect(() => {
    let mounted = true;

    if (Platform.OS === 'web') {
      try {
        const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
        if (mounted) setReduceMotion(mq.matches);
        const handler = (e: MediaQueryListEvent) => {
          if (mounted) setReduceMotion(e.matches);
        };
        mq.addEventListener('change', handler);
        return () => { mounted = false; mq.removeEventListener('change', handler); };
      } catch {
        return () => { mounted = false; };
      }
    }

    AccessibilityInfo.isReduceMotionEnabled().then((enabled) => {
      if (mounted) setReduceMotion(enabled);
    });

    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', (enabled) => {
      if (mounted) setReduceMotion(enabled);
    });

    return () => {
      mounted = false;
      sub.remove();
    };
  }, []);

  const handleLayout = useCallback((e: { nativeEvent: { layout: { width: number } } }) => {
    const width = e.nativeEvent.layout.width;
    setPageWidth(width);
    pageWidthValue.value = width;
  }, [pageWidthValue]);

  // Restore persisted step
  useEffect(() => {
    if (loaded && progress.currentStep > 0 && !progress.completed && pageWidth > 0) {
      const targetX = progress.currentStep * pageWidth;
      scrollTo(scrollRef, targetX, 0, false);
      scrollProgress.value = progress.currentStep;
    }
  }, [loaded, pageWidth]); // eslint-disable-line react-hooks/exhaustive-deps

  const onScroll = useAnimatedScrollHandler({
    onScroll: (event) => {
      const pw = pageWidthValue.value;
      if (pw > 0) {
        scrollProgress.value = event.contentOffset.x / pw;
      }
    },
    onMomentumEnd: (event) => {
      const pw = pageWidthValue.value;
      if (pw > 0) {
        const page = Math.round(event.contentOffset.x / pw);
        runOnJS(updateStep)(page);
      }
    },
  });

  const animateToPage = useCallback(
    (page: number) => {
      'worklet';
      const clamped = Math.max(0, Math.min(page, ONBOARDING_STEPS.length - 1));
      scrollTo(scrollRef, clamped * pageWidthValue.value, 0, true);
    },
    [scrollRef, pageWidthValue],
  );

  const handleNext = useCallback(() => {
    const current = Math.round(scrollProgress.value);
    if (current + 1 < ONBOARDING_STEPS.length) {
      animateToPage(current + 1);
    }
  }, [scrollProgress, animateToPage]);

  const handleBack = useCallback(() => {
    const current = Math.round(scrollProgress.value);
    if (current > 0) {
      animateToPage(current - 1);
    }
  }, [scrollProgress, animateToPage]);

  const handleSkip = useCallback(() => {
    markSkipped();
    onComplete();
  }, [markSkipped, onComplete]);

  const handleDone = useCallback(() => {
    markCompleted();
    onComplete();
  }, [markCompleted, onComplete]);

  const lastIndex = ONBOARDING_STEPS.length - 1;

  const skipStyle = useAnimatedStyle(() => ({
    opacity: interpolate(
      scrollProgress.value,
      [lastIndex - 1, lastIndex],
      [1, 0],
      Extrapolation.CLAMP,
    ),
  }));

  if (!loaded) return null;

  return (
    <View
      style={[styles.container, { backgroundColor: theme.colors.background }]}
      onLayout={handleLayout}
    >
      <Animated.View
        style={[styles.skipContainer, { top: Math.max(insets.top, 12) }, skipStyle]}
        pointerEvents="box-none"
      >
        <Pressable onPress={handleSkip} hitSlop={12}>
          <Text style={[styles.skipText, { color: theme.colors.textSecondary }]}>Skip</Text>
        </Pressable>
      </Animated.View>

      {pageWidth > 0 && (
        <Animated.ScrollView
          ref={scrollRef}
          horizontal
          pagingEnabled
          showsHorizontalScrollIndicator={false}
          scrollEventThrottle={16}
          onScroll={onScroll}
          decelerationRate="fast"
          bounces={false}
          overScrollMode="never"
          style={styles.pagerArea}
        >
          {ONBOARDING_STEPS.map((step, i) => (
            <OnboardingPage
              key={step.id}
              step={step}
              index={i}
              scrollProgress={scrollProgress}
              pageWidth={pageWidth}
              reduceMotion={reduceMotion}
            />
          ))}
        </Animated.ScrollView>
      )}

      <View style={[styles.controlsArea, { paddingBottom: Math.max(insets.bottom, 24) }]}>
        <View style={styles.buttonsWrapper}>
          <OnboardingButtons
            totalSteps={ONBOARDING_STEPS.length}
            scrollProgress={scrollProgress}
            onNext={handleNext}
            onBack={handleBack}
            onDone={handleDone}
          />
        </View>
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  skipContainer: {
    position: 'absolute',
    right: 24,
    zIndex: 10,
  },
  skipText: {
    fontSize: 13,
    fontWeight: '500',
  },
  pagerArea: {
    flex: 1,
  },
  controlsArea: {
    paddingHorizontal: 24,
    paddingTop: 16,
    gap: 24,
  },
  buttonsWrapper: {
    width: '100%',
  },
});

export default memo(OnboardingScreen);
