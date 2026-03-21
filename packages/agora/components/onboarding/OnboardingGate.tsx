import React, { useRef, useState, useEffect, useCallback, memo } from 'react';
import { Dimensions, StyleSheet, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSharedValue } from 'react-native-reanimated';
import BloomBottomSheet, { type BottomSheetRef } from '@oxyhq/bloom/bottom-sheet';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useTheme } from '@/hooks/useTheme';
import { ONBOARDING_STEPS, STORAGE_KEY_ONBOARDING } from './constants';
import OnboardingScreen from './OnboardingScreen';
import type { OnboardingScreenHandle } from './OnboardingScreen';
import OnboardingButtons from './OnboardingButtons';
import type { OnboardingProgress } from './types';

const MAX_CONTENT_HEIGHT = Dimensions.get('window').height * 0.92;

/**
 * Presents the onboarding flow as a bottom sheet whose height adapts
 * per step — content drives the sheet height.
 */
const OnboardingGate: React.FC = () => {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const sheetRef = useRef<BottomSheetRef>(null);
  const screenRef = useRef<OnboardingScreenHandle>(null);
  const scrollProgress = useSharedValue(0);
  const [ready, setReady] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const raw = await AsyncStorage.getItem(STORAGE_KEY_ONBOARDING);
        const progress: OnboardingProgress | null = raw ? JSON.parse(raw) : null;
        if (!cancelled && (!progress || (!progress.completed && !progress.skipped))) {
          setReady(true);
        }
      } catch {
        if (!cancelled) setReady(true);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Present sheet when ready
  useEffect(() => {
    if (ready && !dismissed) {
      sheetRef.current?.present();
    }
  }, [ready, dismissed]);

  const handleComplete = useCallback(() => {
    sheetRef.current?.dismiss();
  }, []);

  const handleDismiss = useCallback(async () => {
    setDismissed(true);
    try {
      const raw = await AsyncStorage.getItem(STORAGE_KEY_ONBOARDING);
      const progress: OnboardingProgress | null = raw ? JSON.parse(raw) : null;
      if (!progress?.completed) {
        await AsyncStorage.setItem(
          STORAGE_KEY_ONBOARDING,
          JSON.stringify({ currentStep: 0, completed: true, skipped: true }),
        );
      }
    } catch {}
  }, []);

  if (!ready || dismissed) return null;

  return (
    <BloomBottomSheet
      ref={sheetRef}
      enablePanDownToClose
      onDismiss={handleDismiss}
      style={styles.sheet}
    >
      <View style={{ maxHeight: MAX_CONTENT_HEIGHT }}>
        <OnboardingScreen
          ref={screenRef}
          scrollProgress={scrollProgress}
          onComplete={handleComplete}
        />
        <View
          style={[
            styles.footer,
            {
              borderTopColor: theme.colors.border,
              backgroundColor: theme.colors.background,
              paddingBottom: Math.max(insets.bottom, 14),
            },
          ]}
        >
          <OnboardingButtons
            totalSteps={ONBOARDING_STEPS.length}
            scrollProgress={scrollProgress}
            onNext={() => screenRef.current?.next()}
            onBack={() => screenRef.current?.back()}
            onDone={() => screenRef.current?.done()}
          />
        </View>
      </View>
    </BloomBottomSheet>
  );
};

const styles = StyleSheet.create({
  sheet: {
    maxWidth: 600,
    marginHorizontal: 'auto',
  },
  footer: {
    paddingHorizontal: 24,
    paddingTop: 12,
    borderTopWidth: 0.5,
  },
});

export default memo(OnboardingGate);
