import React, { useCallback, useRef, useState, useEffect, memo, forwardRef, useImperativeHandle } from 'react';
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
  type SharedValue,
} from 'react-native-reanimated';
import { useAuth } from '@oxyhq/services';

import { useTheme } from '@/hooks/useTheme';
import OnboardingPage from './OnboardingPage';
import InterestsPage from './InterestsPage';
import { useOnboardingProgress } from './useOnboardingProgress';
import { ONBOARDING_STEPS } from './constants';

const DEFAULT_PAGER_HEIGHT = 350;

interface OnboardingScreenProps {
  scrollProgress: SharedValue<number>;
  onComplete: () => void;
}

export interface OnboardingScreenHandle {
  next: () => void;
  back: () => void;
  done: () => void;
}

const OnboardingScreen = forwardRef<OnboardingScreenHandle, OnboardingScreenProps>(
  ({ scrollProgress, onComplete }, ref) => {
    const theme = useTheme();
    const { isAuthenticated } = useAuth();

    const scrollRef = useAnimatedRef<Animated.ScrollView>();
    const pageWidthValue = useSharedValue(0);
    const [pageWidth, setPageWidth] = useState(0);

    const { progress, loaded, updateStep, markCompleted, markSkipped } =
      useOnboardingProgress(isAuthenticated);

    const [reduceMotion, setReduceMotion] = useState(false);

    // --- Pager height management (reanimated v4 continuous interpolation) ---
    const measuredHeights = useRef<Record<number, number>>({});
    const currentStepRef = useRef(0);
    const [pagerHeight, setPagerHeight] = useState(DEFAULT_PAGER_HEIGHT);

    // Shared value storing per-page heights for worklet-driven interpolation
    const pageHeightsShared = useSharedValue<number[]>(
      new Array(ONBOARDING_STEPS.length).fill(DEFAULT_PAGER_HEIGHT),
    );

    // Throttled setter — avoids excessive re-renders during swipes
    const lastSetHeightRef = useRef(DEFAULT_PAGER_HEIGHT);
    const setInterpolatedHeight = useCallback((h: number) => {
      const rounded = Math.round(h);
      if (Math.abs(rounded - lastSetHeightRef.current) >= 2) {
        lastSetHeightRef.current = rounded;
        setPagerHeight(rounded);
      }
    }, []);

    const handleContentHeightMeasured = useCallback((index: number, height: number) => {
      measuredHeights.current[index] = height;
      // Sync to shared value so worklets can interpolate
      const updated = [...pageHeightsShared.value];
      updated[index] = height;
      pageHeightsShared.value = updated;
      // Set initial height for current step
      if (index === currentStepRef.current) {
        lastSetHeightRef.current = height;
        setPagerHeight(height);
      }
    }, [pageHeightsShared]);

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
        currentStepRef.current = progress.currentStep;
        const h = measuredHeights.current[progress.currentStep];
        if (h) {
          lastSetHeightRef.current = h;
          setPagerHeight(h);
        }
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

    // Continuous height interpolation — smoothly tracks scroll progress
    useAnimatedReaction(
      () => {
        const heights = pageHeightsShared.value;
        const prog = scrollProgress.value;
        const maxIdx = heights.length - 1;
        if (maxIdx < 0) return DEFAULT_PAGER_HEIGHT;
        const clamped = Math.max(0, Math.min(prog, maxIdx));
        const floor = Math.floor(clamped);
        const ceil = Math.min(floor + 1, maxIdx);
        const frac = clamped - floor;
        return heights[floor] + (heights[ceil] - heights[floor]) * frac;
      },
      (h) => {
        runOnJS(setInterpolatedHeight)(h);
      },
    );

    // Detect step changes at swipe midpoint for persistence
    useAnimatedReaction(
      () => Math.round(scrollProgress.value),
      (current, previous) => {
        if (previous !== null && current !== previous) {
          runOnJS(updateStep)(current);
        }
      },
      [updateStep],
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
      }
    }, [scrollProgress, animateToPage]);

    const handleBack = useCallback(() => {
      const current = Math.round(scrollProgress.value);
      const prev = current - 1;
      if (prev >= 0) {
        animateToPage(prev);
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

    useImperativeHandle(ref, () => ({
      next: handleNext,
      back: handleBack,
      done: handleDone,
    }), [handleNext, handleBack, handleDone]);

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
              style={{ flex: 1 }}
              contentContainerStyle={{ alignItems: 'flex-start' }}
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
        </View>
    );
  });

const styles = StyleSheet.create({
  container: {
    paddingBottom: 80,
  },
  skipContainer: {
    alignSelf: 'flex-end',
    paddingRight: 24,
    paddingTop: 8,
  },
  skipText: {
    fontSize: 13,
    fontWeight: '500',
  },
});

OnboardingScreen.displayName = 'OnboardingScreen';

export default memo(OnboardingScreen);
