import React from "react";
import { Platform, StyleSheet, View } from "react-native";
import { Slot, Stack, usePathname } from "expo-router";

import { useAuth } from '@oxyhq/services/ui/client';
import { ConnectionStatusToasts } from '@oxyhq/bloom/connection-status';
import { ContentPanel } from '@oxyhq/bloom/content-panel';
import { registerPanelSurface } from '@/components/shell/panelSurface';

import { BottomBar, useBottomBarReservedSpace } from "@/components/BottomBar";
import { DrawerOverlay } from "@/components/DrawerOverlay";
import KeyboardShortcutsModal from "@/components/KeyboardShortcutsModal";
import RegisterPush from '@/components/RegisterPushToken';
import { RealtimePostsBridge } from '@/components/RealtimePostsBridge';
import { RealtimeNotificationsBridge } from '@/components/RealtimeNotificationsBridge';
import { PublicRealtimeBridge } from '@/components/PublicRealtimeBridge';
import { RightBar } from "@/components/RightBar";
import { SideBar } from "@/components/SideBar";
import { SignInBanner } from "@/components/SignInBanner";
import WelcomeModalGate from '@/components/WelcomeModalGate';

import { useKeyboardShortcuts } from "@/hooks/useKeyboardShortcuts";
import { useKeyboardVisibility } from "@/hooks/useKeyboardVisibility";
import { useIsScreenNotMobile } from "@/hooks/useOptimizedMediaQuery";
import { useScreenColor } from '@/context/ScreenColorContext';
import { APP_COLOR_PRESETS, BloomColorScope, useTheme, type AppColorName } from '@oxyhq/bloom/theme';

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
  const reservedSpace = useBottomBarReservedSpace();
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
  // slides own their bottom spacing); 0 on desktop/native. The hook already folds
  // in the bottom safe-area inset — nothing gets added to it here.
  const mobileWebBottomInset =
    IS_WEB && !isScreenNotMobile && isAuthenticated && pathname !== '/videos'
      ? reservedSpace
      : 0;

  // Same center content on both platforms; only the host differs. WEB uses <Slot/>
  // so the route flows in document scroll (the BODY is the scroller) and sticky
  // works — a <Stack>'s viewport-clamped scene would break document scroll + sticky.
  // NATIVE keeps <Stack> for real push/pop + freezeOnBlur (pushed screens stay
  // mounted so `back` restores scroll).
  const centerContent = (
    <>
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
          {/* The reels screen has to mount OVER the feed rather than replacing
              it, and without a push of its own.

              A flying video is one surface handed from the origin to the
              destination, so the destination must exist while the origin is
              still there — a screen swap would unmount the feed first and leave
              the flight nothing to hand over from. `animation: 'none'` is the
              other half: the flight IS the animation, and a push sliding
              underneath it would show the same video moving twice, in two
              directions.

              Accepted cost: reaching Videos from the tab bar loses its push
              animation, because a screen cannot be told to animate for one
              caller and not another. */}
          <Stack.Screen
            name="videos"
            options={{ presentation: 'transparentModal', animation: 'none' }}
          />
        </Stack>
      )}
      {/* Show the anon CTA only once auth is resolved: during cold-boot restore
          `isAuthenticated` is undetermined and would flash the banner to a user
          whose session is about to restore. */}
      {isAuthResolved && !isAuthenticated && <SignInBanner />}
    </>
  );

  // The app-shell contexts this subtree reads (screen color, videos rail, video
  // playback, drawer, bottom-bar visibility) are mounted by <AppShellProviders>
  // up in `components/providers/AppProviders.tsx`. They CANNOT live here: bottom
  // sheets and bloom's native portal outlet render their content above this
  // route, so anything mounted at this depth is invisible to them.
  return (
    <>
      {/* Connection loss shows as a Bloom toast — see @oxyhq/bloom/connection-status.
          It replaced an app-local banner that pushed the whole screen down. */}
      <ConnectionStatusToasts />
      <RealtimePostsBridge />
      <RealtimeNotificationsBridge />
      {/* Ungated on purpose: the public socket is what makes trending realtime
          for signed-out visitors, who cannot connect to the two above at all. */}
      <PublicRealtimeBridge />
      {/* ── visual shell (was MainLayout): SideBar + gutter/ContentPanel + RightBar ── */}
      {/* Every width decision below is a CLASS, not a measured boolean. The
          shell used to read `isScreenNotMobile` for its direction, its cap and
          its gutter — pure styling, which `useOptimizedMediaQuery`'s own docs
          send to NativeWind — so dragging a window re-rendered this subtree on
          every frame to pick between two strings. The hook stays for what it is
          actually for: the mount gates below. */}
      <View className="flex-1 w-full flex-col shell:flex-row shell:justify-center bg-background">
        <SideBar />
        <View className="flex-1 justify-between flex-col shell:flex-row shell:max-w-[950px] shell:shrink bg-background">
          {/* Desktop-web gutter: the `bg-background` band around the floating panel
              (`p-2 pl-0` so the panel meets the rail flush). Gated to the same
              >=500px breakpoint as the sidebar; full-bleed once the sidebar hides. */}
          <View className="flex-1 shell:flex-[2.2] bg-background web:shell:p-2 web:shell:pl-0">
            <BloomColorScope colorPreset={activeScreenColor} asChild>
              <ContentPanel
                framedFrom={500}
                maskColor={theme.colors.background}
                contentStyle={{ paddingBottom: mobileWebBottomInset }}
              >
                {/* Registers the panel's content box so anything aiming at a
                    route that has not mounted yet has something real to
                    measure — see `registerPanelSurface`. A plain wrapper: it
                    adds no style, so it cannot change the layout it reports. */}
                <View style={StyleSheet.absoluteFill} pointerEvents="box-none" ref={registerPanelSurface} />
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
    </>
  );
}
