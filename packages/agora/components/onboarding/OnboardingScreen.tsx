import React, { useCallback, useRef, useState, useEffect, memo } from 'react';
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
  useAnimatedReaction,
  interpolate,
  Extrapolation,
  scrollTo,
  runOnJS,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuth } from '@oxyhq/services';

import { useTheme } from '@/hooks/useTheme';
import OnboardingPage from './OnboardingPage';
import InterestsPage from './InterestsPage';
import OnboardingButtons from './OnboardingButtons';
import { useOnboardingProgress } from './useOnboardingProgress';
import { ONBOARDING_STEPS } from './constants';

const DEFAULT_PAGER_HEIGHT = 350;

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

  // --- Pager height management ---
  const measuredHeights = useRef<Record<number, number>>({});
  const currentStepRef = useRef(0);
  const [pagerHeight, setPagerHeight] = useState(DEFAULT_PAGER_HEIGHT);

  const handleContentHeightMeasured = useCallback((index: number, height: number) => {
    measuredHeights.current[index] = height;
    // Update pager height if this is the currently visible step
    if (index === currentStepRef.current) {
      setPagerHeight(height);
    }
  }, []);

  const updatePagerForStep = useCallback((step: number) => {
    currentStepRef.current = step;
    const measured = measuredHeights.current[step];
    if (measured) {
      setPagerHeight(measured);
    }
  }, []);

  // --- Accessibility ---
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
      updatePagerForStep(progress.currentStep);
    }
  }, [loaded, pageWidth]); // eslint-disable-line react-hooks/exhaustive-deps

  const onScroll = useAnimatedScrollHandler({
    onScroll: (event) => {
      const pw = pageWidthValue.value;
      if (pw > 0) {
        scrollProgress.value = event.contentOffset.x / pw;
      }
    },
  });

  // Detect step changes at swipe midpoint for smooth height transitions
  useAnimatedReaction(
    () => Math.round(scrollProgress.value),
    (current, previous) => {
      if (previous !== null && current !== previous) {
        runOnJS(updateStep)(current);
        runOnJS(updatePagerForStep)(current);
      }
    },
    [updateStep, updatePagerForStep],
  );

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
    const next = current + 1;
    if (next < ONBOARDING_STEPS.length) {
      animateToPage(next);
      updatePagerForStep(next);
    }
  }, [scrollProgress, animateToPage, updatePagerForStep]);

  const handleBack = useCallback(() => {
    const current = Math.round(scrollProgress.value);
    const prev = current - 1;
    if (prev >= 0) {
      animateToPage(prev);
      updatePagerForStep(prev);
    }
  }, [scrollProgress, animateToPage, updatePagerForStep]);

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
        style={[styles.skipContainer, skipStyle]}
        pointerEvents="box-none"
      >
        <Pressable onPress={handleSkip} hitSlop={12}>
          <Text style={[styles.skipText, { color: theme.colors.textSecondary }]}>Skip</Text>
        </Pressable>
      </Animated.View>

      {pageWidth > 0 && (
        <View style={{ height: pagerHeight, overflow: 'hidden' }}>
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
            {ONBOARDING_STEPS.map((step, i) => {
              const PageComponent = step.type === 'interests' ? InterestsPage : OnboardingPage;
              return (
                <PageComponent
                  key={step.id}
                  step={step}
                  index={i}
                  scrollProgress={scrollProgress}
                  pageWidth={pageWidth}
                  reduceMotion={reduceMotion}
                  onContentHeightMeasured={handleContentHeightMeasured}
                />
              );
            })}
          </Animated.ScrollView>
        </View>
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
  container: {},
  skipContainer: {
    alignSelf: 'flex-end',
    paddingRight: 24,
    paddingTop: 8,
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
  },
  buttonsWrapper: {
    width: '100%',
  },
});

export default memo(OnboardingScreen);
