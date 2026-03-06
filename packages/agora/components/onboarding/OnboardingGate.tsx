import React, { useRef, useState, useEffect, useCallback, memo } from 'react';
import { Dimensions, StyleSheet, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSharedValue } from 'react-native-reanimated';
import BottomSheet, {
  BottomSheetView,
  BottomSheetBackdrop,
  BottomSheetFooter,
} from '@gorhom/bottom-sheet';
import type { BottomSheetBackdropProps, BottomSheetFooterProps } from '@gorhom/bottom-sheet';
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
 * per step via enableDynamicSizing — content drives the sheet height.
 */
const OnboardingGate: React.FC = () => {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const sheetRef = useRef<BottomSheet>(null);
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

  const renderFooter = useCallback(
    (props: BottomSheetFooterProps) => (
      <BottomSheetFooter {...props} bottomInset={0}>
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
      </BottomSheetFooter>
    ),
    [scrollProgress, theme, insets.bottom],
  );

  if (!ready || dismissed) return null;

  return (
    <BottomSheet
      ref={sheetRef}
      enableDynamicSizing
      maxDynamicContentSize={MAX_CONTENT_HEIGHT}
      enablePanDownToClose
      enableContentPanningGesture={false}
      onChange={handleSheetChange}
      backdropComponent={renderBackdrop}
      footerComponent={renderFooter}
      backgroundStyle={[styles.background, { backgroundColor: theme.colors.background }]}
      handleIndicatorStyle={{ backgroundColor: theme.colors.textTertiary }}
      style={styles.sheet}
    >
      <BottomSheetView>
        <OnboardingScreen
          ref={screenRef}
          scrollProgress={scrollProgress}
          onComplete={handleComplete}
        />
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
  footer: {
    paddingHorizontal: 24,
    paddingTop: 12,
    borderTopWidth: 0.5,
  },
});

export default memo(OnboardingGate);
