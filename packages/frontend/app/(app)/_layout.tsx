import React from "react";
import { Platform, StyleSheet, View } from "react-native";
import { ExperimentalStack, Slot, usePathname } from "expo-router";

import { useAuth } from '@oxy.so/services/ui/client';
import { ConnectionStatusToasts } from '@oxy.so/bloom/connection-status';
import { AppShell } from '@oxy.so/bloom/app-shell';
import { registerPanelSurface } from '@/components/shell/panelSurface';

import { MentionHomeHeader } from '@/components/navigation/MentionHomeHeader';
import { BottomBar } from "@/components/BottomBar";
import KeyboardShortcutsModal from "@/components/KeyboardShortcutsModal";
import RegisterPush from '@/components/RegisterPushToken';
import { RealtimePostsBridge } from '@/components/RealtimePostsBridge';
import { RealtimeNotificationsBridge } from '@/components/RealtimeNotificationsBridge';
import { PublicRealtimeBridge } from '@/components/PublicRealtimeBridge';
import { RightBar } from "@/components/RightBar";
import { useMentionSidebar } from "@/components/navigation/useMentionSidebar";
import { useDrawer } from "@/context/DrawerContext";
import { SignInBanner } from "@/components/SignInBanner";
import WelcomeModalGate from '@/components/WelcomeModalGate';

import { useKeyboardShortcuts } from "@/hooks/useKeyboardShortcuts";
import { useKeyboardVisibility } from "@/hooks/useKeyboardVisibility";
import { useScreenColor } from '@/context/ScreenColorContext';
import { APP_COLOR_PRESETS, type AppColorName } from '@oxy.so/bloom/theme';

const IS_WEB = Platform.OS === 'web';

/**
 * Profile routes own the screen-level color scope; every other route renders with
 * the app-wide theme. Safety net: ignore any stale screenColor when the pathname
 * is outside the profile subtree (`/@username[/sub]`, `/c/<handle>[/sub]`) so
 * per-profile colors never leak into other pages.
 */
function isProfileRoute(pathname: string | null | undefined): boolean {
  if (!pathname) return false;
  // `/you` is the viewer's own profile as a TAB — the same page, at a route with
  // no handle in it (see `(tabs)/you.tsx`). Without it here the one profile a
  // reader looks at most would be the only one rendering outside its own colour
  // scope.
  //
  // `/c/` is the same screen for a channel (`ChannelScreen` resolves its preset
  // through the same `useProfileAccount` -> `useProfileScreenColor`, which
  // publishes it here). It scopes its own subtree either way; what this adds is
  // the PANEL. Chrome reads the surface the panel painted (`useSurfaceFill`), so
  // a channel whose column was tinted from inside its own scope, on a panel
  // painted outside it, would otherwise paint the app-wide card against the
  // channel's tinted children.
  return pathname.startsWith('/@') || pathname.startsWith('/c/') || pathname === '/you';
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
  const sidebar = useMentionSidebar();
  const keyboardVisible = useKeyboardVisibility();
  const drawer = useDrawer();
  const { isAuthenticated, isAuthResolved } = useAuth();
  const { screenColor } = useScreenColor();
  const pathname = usePathname();
  const onProfileRoute = isProfileRoute(pathname);

  const activeScreenColor: AppColorName | undefined =
    onProfileRoute && screenColor && APP_COLOR_PRESETS[screenColor] ? screenColor : undefined;

  // Same center content on both platforms; only the host differs. WEB uses <Slot/>
  // so the route flows in document scroll (the BODY is the scroller) and sticky
  // works — a <Stack>'s viewport-clamped scene would break document scroll + sticky.
  // NATIVE uses Expo Router's predictive-back-aware stack. The standard Stack
  // cannot consume Android's predictive callback and lets the Activity close;
  // all native stacks must use ExperimentalStack together on Android.
  const centerContent = (
    <>
      {IS_WEB ? (
        <Slot />
      ) : (
        <ExperimentalStack screenOptions={{ headerShown: false }}>
          {/* The five root tabs, as ONE stack screen. Everything else in this
              group is pushed over them, which is what keeps the tabs alive
              underneath a post or a settings page and what makes Back return to
              the tab the reader came from.

              This entry replaces the one `videos` used to have. That entry
              existed so the reels screen would mount OVER the feed rather than
              replacing it: a flying video is one surface handed from origin to
              destination, so the destination must exist while the origin is
              still there, and a screen swap would unmount the feed first and
              leave the flight nothing to hand over from. Inside the tabs both
              screens are simply mounted at once, permanently — the property is
              now structural instead of a stack-attachment detail. */}
          <ExperimentalStack.Screen name="(tabs)" />
          <ExperimentalStack.Screen name="compose" />
          <ExperimentalStack.Screen name="p/[id]/boost" />
        </ExperimentalStack>
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
      {/* Connection loss shows as a Bloom toast — see @oxy.so/bloom/connection-status.
          It replaced an app-local banner that pushed the whole screen down. */}
      <ConnectionStatusToasts />
      <RealtimePostsBridge />
      <RealtimeNotificationsBridge />
      {/* Ungated on purpose: the public socket is what makes trending realtime
          for signed-out visitors, who cannot connect to the two above at all. */}
      <PublicRealtimeBridge />
      <AppShell
        variant="feed"
        scroll={IS_WEB ? 'document' : 'fixed'}
        panel
        panelColorPreset={activeScreenColor}
        drawer="reveal"
        drawerOpen={drawer.isOpen}
        onDrawerOpenChange={open => open ? drawer.open() : drawer.close()}
        sidebar={sidebar}
        header={pathname === '/' ? <MentionHomeHeader /> : null}
        contentWidth={620}
        navigationAlign="content"
        navigationGap={0}
        asideGap={0}
        gutter={8}
        navFrom={500}
        navExpandedFrom={1300}
        asideFrom={990}
        asideWidth={350}
        asideCollapse="hidden"
        aside={<RightBar />}
        bottomBar={isAuthenticated && !keyboardVisible ? <BottomBar /> : undefined}
        reserveBottomBarSpace={pathname !== '/videos' && pathname !== '/camera'}
      >
        <View style={StyleSheet.absoluteFill} pointerEvents="box-none" ref={registerPanelSurface} />
        {centerContent}
      </AppShell>
      <RegisterPush />
      <WelcomeModalGate appIsReady={true} />
      {Platform.OS === 'web' && <KeyboardShortcutsHost />}
    </>
  );
}
