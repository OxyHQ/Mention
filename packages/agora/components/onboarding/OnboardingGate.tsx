import React, { useRef, useState, useEffect, useCallback, memo } from 'react';
import { StyleSheet } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import BottomSheet, {
  BottomSheetView,
  BottomSheetBackdrop,
} from '@gorhom/bottom-sheet';
import type { BottomSheetBackdropProps } from '@gorhom/bottom-sheet';

import { useTheme } from '@/hooks/useTheme';
import { STORAGE_KEY_ONBOARDING } from './constants';
import OnboardingScreen from './OnboardingScreen';
import type { OnboardingProgress } from './types';

/**
 * Presents the onboarding flow as a dynamically-sized bottom sheet.
 * Auto-presents when onboarding hasn't been completed or skipped.
 * Dismissing via swipe-down is treated as skip.
 */
const OnboardingGate: React.FC = () => {
  const theme = useTheme();
  const sheetRef = useRef<BottomSheet>(null);
  const [ready, setReady] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  // Check storage to decide whether to show onboarding
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

  const handleComplete = useCallback(() => {
    sheetRef.current?.close();
  }, []);

  const handleSheetChange = useCallback(async (index: number) => {
    if (index === -1) {
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
    }
  }, []);

  const renderBackdrop = useCallback(
    (props: BottomSheetBackdropProps) => (
      <BottomSheetBackdrop
        {...props}
        disappearsOnIndex={-1}
        appearsOnIndex={0}
        opacity={0.6}
        pressBehavior="none"
      />
    ),
    [],
  );

  if (!ready || dismissed) return null;

  return (
    <BottomSheet
      ref={sheetRef}
      enableDynamicSizing
      enablePanDownToClose
      enableContentPanningGesture={false}
      onChange={handleSheetChange}
      backdropComponent={renderBackdrop}
      backgroundStyle={[styles.background, { backgroundColor: theme.colors.background }]}
      handleIndicatorStyle={{ backgroundColor: theme.colors.textTertiary }}
      style={styles.sheet}
    >
      <BottomSheetView>
        <OnboardingScreen onComplete={handleComplete} />
      </BottomSheetView>
    </BottomSheet>
  );
};

const styles = StyleSheet.create({
  background: {
    borderRadius: 24,
  },
  sheet: {
    maxWidth: 600,
    marginHorizontal: 'auto',
  },
  content: {},
});

export default memo(OnboardingGate);
