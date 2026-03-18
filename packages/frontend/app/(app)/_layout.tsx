import React, { useCallback, useMemo, memo } from "react";
import { Platform, Pressable, StyleSheet, View } from "react-native";
import { Slot } from "expo-router";
import Animated, { useAnimatedStyle, withTiming } from "react-native-reanimated";

import { useAuth } from '@oxyhq/services';

import { BottomBar } from "@/components/BottomBar";
import KeyboardShortcutsModal from "@/components/KeyboardShortcutsModal";
import RegisterPush from '@/components/RegisterPushToken';
import { RealtimePostsBridge } from '@/components/RealtimePostsBridge';
import { RightBar } from "@/components/RightBar";
import { SideBar } from "@/components/SideBar";
import { SignInBanner } from "@/components/SignInBanner";
import { ThemedView } from "@/components/ThemedView";
import WelcomeModalGate from '@/components/WelcomeModalGate';
import ConnectionStatus from '@/components/common/ConnectionStatus';

import { useKeyboardShortcuts } from "@/hooks/useKeyboardShortcuts";
import { useKeyboardVisibility } from "@/hooks/useKeyboardVisibility";
import { useIsScreenNotMobile } from "@/hooks/useOptimizedMediaQuery";
import { useLayoutScroll } from '@/context/LayoutScrollContext';
import { DrawerProvider, useDrawer } from '@/context/DrawerContext';
import { cn } from '@/lib/utils';

interface MainLayoutProps {
  isScreenNotMobile: boolean;
}

const DrawerOverlay = memo(function DrawerOverlay() {
  const { isOpen, close } = useDrawer();

  const backdropStyle = useAnimatedStyle(() => ({
    opacity: withTiming(isOpen ? 1 : 0, { duration: 200 }),
    pointerEvents: isOpen ? 'auto' as const : 'none' as const,
  }));

  const drawerStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: withTiming(isOpen ? 0 : -300, { duration: 250 }) },
    ],
  }));

  return (
    <Animated.View style={[styles.backdrop, backdropStyle]}>
      <Pressable style={styles.backdropPressable} onPress={close} />
      <Animated.View style={[styles.drawer, drawerStyle]}>
        <SideBar asDrawer onNavigate={close} />
      </Animated.View>
    </Animated.View>
  );
});

const MainLayout: React.FC<MainLayoutProps> = memo(({ isScreenNotMobile }) => {
  const { forwardWheelEvent } = useLayoutScroll();

  const handleWheel = useCallback((event: any) => {
    forwardWheelEvent(event);
  }, [forwardWheelEvent]);

  const containerProps = useMemo(
    () => (Platform.OS === 'web' ? { onWheel: handleWheel } : {}),
    [handleWheel]
  );

  return (
    <View
      className={cn(
        "flex-1 w-full bg-background",
        isScreenNotMobile ? "flex-row justify-center" : "flex-col"
      )}
      {...containerProps}
    >
      <SideBar />
      <View
        className={cn(
          "flex-1 justify-between bg-background",
          isScreenNotMobile ? "flex-row" : "flex-col"
        )}
        style={isScreenNotMobile ? { maxWidth: 950, flexShrink: 1 } : undefined}
      >
        <ThemedView
          className={cn(
            "bg-background",
            isScreenNotMobile && "border-x border-border"
          )}
          style={{
            flex: isScreenNotMobile ? 2.2 : 1,
          }}
        >
          <Slot />
        </ThemedView>
        <RightBar />
      </View>
      {!isScreenNotMobile && <DrawerOverlay />}
    </View>
  );
});

MainLayout.displayName = 'MainLayout';

export default function AppLayout() {
  const isScreenNotMobile = useIsScreenNotMobile();
  const keyboardVisible = useKeyboardVisibility();
  const { isAuthenticated } = useAuth();
  const { showHelpModal, setShowHelpModal } = useKeyboardShortcuts();

  return (
    <DrawerProvider>
      <ConnectionStatus />
      <RealtimePostsBridge />
      <MainLayout isScreenNotMobile={isScreenNotMobile} />
      <RegisterPush />
      {isAuthenticated && !isScreenNotMobile && !keyboardVisible && <BottomBar />}
      {!isAuthenticated && <SignInBanner />}
      <WelcomeModalGate appIsReady={true} />
      {Platform.OS === 'web' && (
        <KeyboardShortcutsModal
          visible={showHelpModal}
          onClose={() => setShowHelpModal(false)}
        />
      )}
    </DrawerProvider>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    ...Platform.select({
      web: {
        position: 'fixed' as any,
      },
      default: {
        position: 'absolute',
      },
    }),
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0, 0, 0, 0.4)',
    zIndex: 2000,
  },
  backdropPressable: {
    ...StyleSheet.absoluteFillObject,
  },
  drawer: {
    position: 'absolute',
    top: 0,
    left: 0,
    bottom: 0,
    width: 280,
    zIndex: 2001,
  },
});
