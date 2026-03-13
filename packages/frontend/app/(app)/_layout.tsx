import React, { useCallback, useMemo, memo } from "react";
import { Platform, View } from "react-native";
import { Slot } from "expo-router";

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
import { cn } from '@/lib/utils';

interface MainLayoutProps {
  isScreenNotMobile: boolean;
}

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
        "flex-1 w-full mx-auto bg-background",
        isScreenNotMobile ? "flex-row" : "flex-col"
      )}
      {...containerProps}
    >
      <SideBar />
      <View
        className={cn(
          "flex-1 justify-between bg-background",
          isScreenNotMobile ? "flex-row mx-auto" : "flex-col"
        )}
        style={{ maxWidth: 950 }}
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
    <>
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
    </>
  );
}
