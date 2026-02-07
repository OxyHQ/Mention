import React, { useCallback, useMemo, memo } from "react";
import { Platform, StyleSheet, View } from "react-native";
import { Slot } from "expo-router";

import { BottomBar } from "@/components/BottomBar";
import RegisterPush from '@/components/RegisterPushToken';
import { RealtimePostsBridge } from '@/components/RealtimePostsBridge';
import { RightBar } from "@/components/RightBar";
import { SideBar } from "@/components/SideBar";
import { ThemedView } from "@/components/ThemedView";
import WelcomeModalGate from '@/components/WelcomeModalGate';

import { useKeyboardVisibility } from "@/hooks/useKeyboardVisibility";
import { useIsScreenNotMobile } from "@/hooks/useOptimizedMediaQuery";
import { useTheme } from '@/hooks/useTheme';
import { useLayoutScroll } from '@/context/LayoutScrollContext';

interface MainLayoutProps {
  isScreenNotMobile: boolean;
}

const MainLayout: React.FC<MainLayoutProps> = memo(({ isScreenNotMobile }) => {
  const theme = useTheme();
  const { forwardWheelEvent } = useLayoutScroll();

  const styles = useMemo(() => StyleSheet.create({
    container: {
      flex: 1,
      width: '100%',
      marginHorizontal: 'auto',
      flexDirection: isScreenNotMobile ? 'row' : 'column',
      backgroundColor: theme.colors.background,
    },
    mainContent: {
      maxWidth: 950,
      marginHorizontal: isScreenNotMobile ? 'auto' : 0,
      justifyContent: 'space-between',
      flexDirection: isScreenNotMobile ? 'row' : 'column',
      flex: 1,
      backgroundColor: theme.colors.background,
    },
    mainContentWrapper: {
      flex: isScreenNotMobile ? 2.2 : 1,
      ...(isScreenNotMobile ? {
        borderLeftWidth: 0.5,
        borderRightWidth: 0.5,
        borderColor: theme.colors.border,
      } : {}),
      backgroundColor: theme.colors.background,
    },
  }), [isScreenNotMobile, theme.colors.background, theme.colors.border]);

  const handleWheel = useCallback((event: any) => {
    forwardWheelEvent(event);
  }, [forwardWheelEvent]);

  const containerProps = useMemo(
    () => (Platform.OS === 'web' ? { onWheel: handleWheel } : {}),
    [handleWheel]
  );

  return (
    <View style={styles.container} {...containerProps}>
      <SideBar />
      <View style={styles.mainContent}>
        <ThemedView style={styles.mainContentWrapper}>
          <Slot />
        </ThemedView>
        <RightBar />
      </View>
    </View>
  );
});

MainLayout.displayName = 'MainLayout';

export default function AppLayout() {
  const isScreenNotMobile = useIsScreenNotMobile();
  const keyboardVisible = useKeyboardVisibility();

  return (
    <>
      <RealtimePostsBridge />
      <MainLayout isScreenNotMobile={isScreenNotMobile} />
      <RegisterPush />
      {!isScreenNotMobile && !keyboardVisible && <BottomBar />}
      <WelcomeModalGate appIsReady={true} />
    </>
  );
}
