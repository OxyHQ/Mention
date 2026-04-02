import React, { useCallback, useEffect, useMemo, useState, memo } from "react";
import { Platform, Pressable, StyleSheet, View } from "react-native";
import { Slot } from "expo-router";
import Animated, { interpolate, useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";

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
import { ScreenColorProvider, useScreenColor } from '@/context/ScreenColorContext';
import { APP_COLOR_PRESETS, getScopedColorCSSVariables } from '@/lib/app-color-presets';
import { useTheme } from '@oxyhq/bloom/theme';
import { vars } from 'react-native-css';
import { cn } from '@/lib/utils';

interface MainLayoutProps {
  isScreenNotMobile: boolean;
}

const DrawerOverlay = memo(function DrawerOverlay() {
  const { isOpen, close } = useDrawer();
  const progress = useSharedValue(0);
  const [hasOpened, setHasOpened] = useState(false);

  useEffect(() => {
    if (isOpen && !hasOpened) {
      setHasOpened(true);
    }
    progress.value = withTiming(isOpen ? 1 : 0, { duration: 200 });
  }, [isOpen, progress, hasOpened]);

  const backdropStyle = useAnimatedStyle(() => ({
    opacity: progress.value,
    pointerEvents: (progress.value > 0 ? 'auto' : 'none') as 'auto' | 'none',
  }));

  const drawerStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: interpolate(progress.value, [0, 1], [-300, 0]) }],
  }));

  if (!hasOpened) return null;

  return (
    <Animated.View style={[styles.backdrop, backdropStyle]}>
      <Pressable style={styles.backdropPressable} onPress={close} />
      <Animated.View style={[styles.drawer, drawerStyle]}>
        <SideBar asDrawer onNavigate={close} />
      </Animated.View>
    </Animated.View>
  );
});

const MainLayout: React.FC<MainLayoutProps & { isAuthenticated: boolean }> = memo(({ isScreenNotMobile, isAuthenticated }) => {
  const { forwardWheelEvent } = useLayoutScroll();
  const { screenColor } = useScreenColor();
  const theme = useTheme();

  const handleWheel = useCallback((event: any) => {
    forwardWheelEvent(event);
  }, [forwardWheelEvent]);

  const containerProps = useMemo(
    () => (Platform.OS === 'web' ? { onWheel: handleWheel } : {}),
    [handleWheel]
  );

  // Apply screen-level color scoping to the middle column so layout-owned
  // elements (e.g. SignInBanner) inherit the active screen's color preset.
  const screenColorVars = useMemo(() => {
    if (!screenColor) return undefined;
    const preset = APP_COLOR_PRESETS[screenColor];
    if (!preset) return undefined;
    return vars(getScopedColorCSSVariables(preset, theme.isDark ? 'dark' : 'light'));
  }, [screenColor, theme.isDark]);

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
          style={[
            { flex: isScreenNotMobile ? 2.2 : 1 },
            screenColorVars,
          ]}
        >
          <Slot />
          {!isAuthenticated && <SignInBanner />}
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
  const { isAuthenticated } = useAuth();
  const { showHelpModal, setShowHelpModal } = useKeyboardShortcuts();
  const handleCloseHelpModal = useCallback(() => setShowHelpModal(false), [setShowHelpModal]);

  return (
    <ScreenColorProvider>
    <DrawerProvider>
      <ConnectionStatus />
      <RealtimePostsBridge />
      <MainLayout isScreenNotMobile={isScreenNotMobile} isAuthenticated={isAuthenticated} />
      <RegisterPush />
      {isAuthenticated && !isScreenNotMobile && !keyboardVisible && <BottomBar />}
      {!isScreenNotMobile && <DrawerOverlay />}
      <WelcomeModalGate appIsReady={true} />
      {Platform.OS === 'web' && (
        <KeyboardShortcutsModal
          visible={showHelpModal}
          onClose={handleCloseHelpModal}
        />
      )}
    </DrawerProvider>
    </ScreenColorProvider>
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
