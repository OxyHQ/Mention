import React from "react";
import { Platform, View } from "react-native";
import { Slot, Stack, usePathname } from "expo-router";

import { useAuth } from '@oxyhq/services';
import { ContentPanel } from '@oxyhq/bloom/content-panel';

import { BottomBar, BOTTOM_BAR_RESERVED_SPACE } from "@/components/BottomBar";
import { DrawerOverlay } from "@/components/DrawerOverlay";
import KeyboardShortcutsModal from "@/components/KeyboardShortcutsModal";
import RegisterPush from '@/components/RegisterPushToken';
import { RealtimePostsBridge } from '@/components/RealtimePostsBridge';
import { RightBar } from "@/components/RightBar";
import { SideBar } from "@/components/SideBar";
import { SignInBanner } from "@/components/SignInBanner";
import WelcomeModalGate from '@/components/WelcomeModalGate';
import ConnectionStatus from '@/components/common/ConnectionStatus';
import { AppShellProviders } from '@/components/providers/AppShellProviders';

import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useKeyboardShortcuts } from "@/hooks/useKeyboardShortcuts";
import { useKeyboardVisibility } from "@/hooks/useKeyboardVisibility";
import { useIsScreenNotMobile } from "@/hooks/useOptimizedMediaQuery";
import { useScreenColor } from '@/context/ScreenColorContext';
import { APP_COLOR_PRESETS, BloomColorScope, useTheme, type AppColorName } from '@oxyhq/bloom/theme';
import { ScrollRestorationProvider } from '@oxyhq/bloom/scroll';
import { cn } from '@/lib/utils';

const IS_WEB = Platform.OS === 'web';

/**
 * Profile routes own the screen-level color scope; every other route renders with
 * the app-wide theme. Safety net: ignore any stale screenColor when the pathname
 * is outside the profile subtree (`/@username[/sub]`) so per-profile colors never
 * leak into other pages.
 */
function isProfileRoute(pathname: string | null | undefined): boolean {
  if (!pathname) return false;
  return pathname.startsWith('/@');
}

/**
 * Leaf host for the mobile BottomBar. Owns the high-frequency `keyboardVisible`
 * read so a keyboard toggle re-renders only this tiny node — not the whole shell
 * (the feed no longer re-renders when the keyboard opens/closes).
 */
function BottomBarHost() {
  const keyboardVisible = useKeyboardVisibility();
  return keyboardVisible ? null : <BottomBar />;
}

/**
 * Leaf host for the web keyboard-shortcuts help modal. Owns `showHelpModal` so its
 * high-frequency toggle stays isolated from the visual shell.
 */
function KeyboardShortcutsHost() {
  const { showHelpModal, setShowHelpModal } = useKeyboardShortcuts();
  return (
    <KeyboardShortcutsModal visible={showHelpModal} onClose={() => setShowHelpModal(false)} />
  );
}

export default function AppLayout() {
  const isScreenNotMobile = useIsScreenNotMobile();
  const { isAuthenticated, isAuthResolved } = useAuth();
  const { screenColor } = useScreenColor();
  const pathname = usePathname();
  const insets = useSafeAreaInsets();
  const onProfileRoute = isProfileRoute(pathname);

  // Unscoped app theme: this runs OUTSIDE the `<BloomColorScope>` below, so
  // `theme.colors.background` is the app-wide background. Passed to the panel as
  // `maskColor` so the sticky gutter bleed-mask matches the outer gutter band —
  // without it the panel reads the SCOPED background and a faint corner seam shows
  // on profile routes.
  const theme = useTheme();

  const activeScreenColor: AppColorName | undefined =
    onProfileRoute && screenColor && APP_COLOR_PRESETS[screenColor] ? screenColor : undefined;

  // Mobile-web: the BottomBar is `position: fixed` (see BottomBar.tsx) so it takes
  // no document-scroll space. Reserve its footprint as `paddingBottom` so the last
  // item of every route clears it. Excludes /videos (full-viewport scroll-snap
  // slides own their bottom spacing); 0 on desktop/native.
  const mobileWebBottomInset =
    IS_WEB && !isScreenNotMobile && isAuthenticated && pathname !== '/videos'
      ? BOTTOM_BAR_RESERVED_SPACE + insets.bottom
      : 0;

  // Same center content on both platforms; only the host differs. WEB uses <Slot/>
  // so the route flows in document scroll (the BODY is the scroller) and sticky
  // works — a <Stack>'s viewport-clamped scene would break document scroll + sticky.
  // NATIVE keeps <Stack> for real push/pop + freezeOnBlur (pushed screens stay
  // mounted so `back` restores scroll).
  const centerContent = (
    <ScrollRestorationProvider>
      {IS_WEB ? (
        <Slot />
      ) : (
        <Stack
          screenOptions={{
            headerShown: false,
            animation: 'default',
            freezeOnBlur: true,
            contentStyle: { flex: 1, backgroundColor: 'transparent' },
          }}
        >
          <Stack.Screen name="compose" options={{ presentation: 'modal' }} />
          <Stack.Screen name="p/[id]/boost" options={{ presentation: 'modal' }} />
        </Stack>
      )}
      {/* Show the anon CTA only once auth is resolved: during cold-boot restore
          `isAuthenticated` is undetermined and would flash the banner to a user
          whose session is about to restore. */}
      {isAuthResolved && !isAuthenticated && <SignInBanner />}
    </ScrollRestorationProvider>
  );

  return (
    <AppShellProviders>
      <ConnectionStatus />
      <RealtimePostsBridge />
      {/* ── visual shell (was MainLayout): SideBar + gutter/ContentPanel + RightBar ── */}
      <View
        className={cn(
          "flex-1 w-full bg-background",
          isScreenNotMobile ? "flex-row justify-center" : "flex-col"
        )}
      >
        <SideBar />
        <View
          className={cn(
            "flex-1 justify-between bg-background",
            isScreenNotMobile ? "flex-row" : "flex-col"
          )}
          style={isScreenNotMobile ? { maxWidth: 950, flexShrink: 1 } : undefined}
        >
          {/* Desktop-web gutter: the `bg-background` band around the floating panel
              (`p-2 pl-0` so the panel meets the rail flush). Gated to the same
              >=500px breakpoint as the sidebar; full-bleed once the sidebar hides. */}
          <View
            className={cn(
              "bg-background",
              IS_WEB && isScreenNotMobile && "p-2 pl-0",
            )}
            style={{ flex: isScreenNotMobile ? 2.2 : 1 }}
          >
            <BloomColorScope colorPreset={activeScreenColor} asChild>
              <ContentPanel
                framed={IS_WEB && isScreenNotMobile}
                maskColor={theme.colors.background}
                contentStyle={{ paddingBottom: mobileWebBottomInset }}
              >
                {centerContent}
              </ContentPanel>
            </BloomColorScope>
          </View>
          <RightBar />
        </View>
      </View>
      <RegisterPush />
      {isAuthenticated && !isScreenNotMobile && <BottomBarHost />}
      {!isScreenNotMobile && <DrawerOverlay />}
      <WelcomeModalGate appIsReady={true} />
      {Platform.OS === 'web' && <KeyboardShortcutsHost />}
    </AppShellProviders>
  );
}
