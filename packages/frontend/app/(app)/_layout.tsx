import React, { useCallback, useEffect, useState, memo } from "react";
import { Platform, Pressable, StyleSheet, View } from "react-native";
import { Slot, Stack, usePathname } from "expo-router";
import Animated, { interpolate, useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";

import { useAuth } from '@oxyhq/services';
import { ContentPanel } from '@oxyhq/bloom/content-panel';

import { BottomBar, BOTTOM_BAR_RESERVED_SPACE } from "@/components/BottomBar";
import KeyboardShortcutsModal from "@/components/KeyboardShortcutsModal";
import RegisterPush from '@/components/RegisterPushToken';
import { RealtimePostsBridge } from '@/components/RealtimePostsBridge';
import { RightBar } from "@/components/RightBar";
import { SideBar } from "@/components/SideBar";
import { SignInBanner } from "@/components/SignInBanner";
import WelcomeModalGate from '@/components/WelcomeModalGate';
import ConnectionStatus from '@/components/common/ConnectionStatus';

import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useKeyboardShortcuts } from "@/hooks/useKeyboardShortcuts";
import { useKeyboardVisibility } from "@/hooks/useKeyboardVisibility";
import { useIsScreenNotMobile } from "@/hooks/useOptimizedMediaQuery";
import { BottomBarVisibilityProvider } from '@/context/BottomBarVisibilityContext';
import { DrawerProvider, useDrawer } from '@/context/DrawerContext';
import { ScreenColorProvider, useScreenColor } from '@/context/ScreenColorContext';
import { VideosRailProvider } from '@/context/VideosRailContext';
import { ActiveVideoProvider } from '@/context/ActiveVideoContext';
import { APP_COLOR_PRESETS, BloomColorScope, useTheme, type AppColorName } from '@oxyhq/bloom/theme';
import { ScrollRestorationProvider } from '@oxyhq/bloom/scroll';
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

  // POSITIONING: on NATIVE the backdrop + drawer panel pin via the inline
  // `position: 'absolute'` + inset values in `styles` below. On WEB the app
  // uses a DOCUMENT-scroll model (the window is the scroller), so
  // `position: absolute` resolves against the tall document's initial
  // containing block and the overlay SINKS to the bottom of the document
  // instead of covering the viewport. WEB therefore pins to the viewport via
  // the `web:fixed` NativeWind classes — full-viewport `web:inset-0` for the
  // backdrop scrim, and `web:fixed` pinned to the left edge for the sliding
  // panel. The `web:fixed` MUST live on the SAME elements that carry the
  // opacity / translateX transforms: a transformed ancestor becomes the
  // containing block for any `position: fixed` descendant (it would re-trap
  // it), so the fixed element has to be the transformed one — the translateX
  // then just offsets the already-fixed panel for the slide-in. Mirrors
  // BottomBar.tsx (`web:fixed web:inset-x-4 web:bottom-3`) and the live-room
  // dock. No inline `position: 'fixed'` cast.
  return (
    <Animated.View
      className="web:fixed web:inset-0 web:z-[2000]"
      style={[styles.backdrop, backdropStyle]}
    >
      <Pressable style={styles.backdropPressable} onPress={close} />
      <Animated.View
        className="web:fixed web:left-0 web:top-0 web:bottom-0 web:z-[2001]"
        style={[styles.drawer, drawerStyle]}
      >
        <SideBar asDrawer onNavigate={close} />
      </Animated.View>
    </Animated.View>
  );
});

/**
 * Profile routes own the screen-level color scope. Any other route must render
 * with the app-wide theme, so the layout ignores any stale screenColor value
 * when the pathname is outside the profile subtree. This is the safety net
 * that prevents per-profile colors from leaking into other pages.
 */
function isProfileRoute(pathname: string | null | undefined): boolean {
  if (!pathname) return false;
  // Expo Router represents profile routes as /@username[/sub]
  return pathname.startsWith('/@');
}

const IS_WEB = Platform.OS === 'web';

const MainLayout: React.FC<MainLayoutProps & { isAuthenticated: boolean; isAuthResolved: boolean }> = memo(({ isScreenNotMobile, isAuthenticated, isAuthResolved }) => {
  const { screenColor } = useScreenColor();
  const pathname = usePathname();
  const insets = useSafeAreaInsets();
  const onProfileRoute = isProfileRoute(pathname);
  const isVideosScreen = pathname === '/videos';

  // Unscoped app theme. This `useTheme()` runs at the MainLayout level — OUTSIDE
  // the `<BloomColorScope>` that wraps `<ContentPanel>` below — so
  // `theme.colors.background` is the app-wide background, NOT the per-profile
  // tinted one. It is passed to the panel as `maskColor` so the sticky gutter
  // bleed-mask ring matches the unscoped outer gutter band; without it the panel
  // reads the SCOPED background internally and a faint corner seam appears on
  // profile routes.
  const theme = useTheme();

  const activeScreenColor: AppColorName | undefined =
    onProfileRoute && screenColor && APP_COLOR_PRESETS[screenColor] ? screenColor : undefined;

  // Mobile-web only: the BottomBar is `position: fixed` to the viewport bottom
  // (see BottomBar.tsx), so it no longer takes layout space in the document
  // scroll. Reserve its footprint (pill height + gap + breathing room + the
  // safe-area bottom inset) as `paddingBottom` on the single shared feed-content
  // wrapper below so the last scrollable item of EVERY route clears the bar
  // instead of hiding behind it. Only when the bar actually renders
  // (authenticated mobile-web); 0 on desktop and native (native pins the bar in
  // its own overlay and screens own their own bottom spacing). The immersive
  // Reels viewer (/videos) is excluded: its slides are full-viewport with
  // scroll-snap and it manages its own bottom spacing, so a shell tail would add
  // a snap-breaking gap after the last slide.
  const mobileWebBottomInset =
    IS_WEB && !isScreenNotMobile && isAuthenticated && pathname !== '/videos'
      ? BOTTOM_BAR_RESERVED_SPACE + insets.bottom
      : 0;

  // The center column content is identical on both platforms; only its host
  // differs. WEB uses <Slot/> so the matched route flows in normal document
  // flow (the BODY is the scroller) and the sticky shell works — a <Stack>'s
  // absolute, viewport-clamped scene wrapper would break document scroll +
  // sticky. NATIVE keeps <Stack> for real push/pop + freezeOnBlur, with
  // pushed-from screens staying mounted (so `back` restores scroll natively).
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
      {/* Only show the anon CTA once auth is definitively resolved. During the
          cold-boot restore window `isAuthenticated` is UNDETERMINED — showing
          the banner then would flash it to a user whose session is about to
          restore. */}
      {isAuthResolved && !isAuthenticated && <SignInBanner />}
    </ScrollRestorationProvider>
  );

  return (
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
        // 950 + 360: on /videos the right bar grows by RightBar.tsx's
        // `REPLIES_COLUMN_WIDTH` (360px, the always-open replies column beside
        // the rail), so the cap widens by that exact amount too — otherwise the
        // center content's flex-grow column (below) would absorb the loss and
        // squeeze the video to less than half its normal width.
        style={isScreenNotMobile ? { maxWidth: isVideosScreen ? 1310 : 950, flexShrink: 1 } : undefined}
      >
        {/* Gutter wrapper (desktop web only). This is the `bg-background` band
            that shows AROUND the floating panel — 8px on top/right/bottom, 0 on
            the left so the panel meets the rail flush (mirrors Mercaria's
            `p-2 pl-0`). The padding is the gutter; the rounded `bg-card`
            panel below floats inside it with all four corners visible. Gated to
            the SAME `isScreenNotMobile` (>=500px) breakpoint that shows the left
            sidebar — NOT the wider `md:` (768px) — so the gutter margins persist
            for exactly as long as the sidebar does and the panel drops to
            full-bleed only when the sidebar hides (no padding, the panel fills
            the column edge-to-edge). The wrapper carries the column's flex
            weight; the inner panel fills the padded box (`flex: 1`). */}
        <View
          className={cn(
            "bg-background",
            IS_WEB && isScreenNotMobile && "p-2 pl-0",
          )}
          style={{ flex: isScreenNotMobile ? 2.2 : 1 }}
        >
        <BloomColorScope colorPreset={activeScreenColor} asChild>
          {/* The framed app-content panel (rounded `bg-card` surface, the sticky
              gutter bleed-mask box-shadow ring, and the single continuous rounded
              border frame) is owned by Bloom's shared `ContentPanel`. `framed`
              is on for desktop web (>=500px, the SAME breakpoint that shows the
              sidebar + gutter margins); on native and mobile web it renders
              full-bleed. `contentStyle` carries the mobile-web bottom inset that
              clears the fixed BottomBar. */}
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
  );
});

MainLayout.displayName = 'MainLayout';

export default function AppLayout() {
  const isScreenNotMobile = useIsScreenNotMobile();
  const keyboardVisible = useKeyboardVisibility();
  const { isAuthenticated, isAuthResolved } = useAuth();
  const { showHelpModal, setShowHelpModal } = useKeyboardShortcuts();
  const handleCloseHelpModal = useCallback(() => setShowHelpModal(false), [setShowHelpModal]);

  return (
    <ScreenColorProvider>
    <VideosRailProvider>
    {/* One shared "only the on-screen video plays" coordinator for the whole
        (app) group — every feed VideoPlayer (home/explore/profile/post detail)
        reports its viewport position to this single Provider so just the
        centered video plays on web (Bluesky's mechanism). The immersive reels
        screen uses its own player surface (not VideoPlayer) and the composer
        previews use raw players, so neither participates. Native + gif videos
        fall back to autoplay (see ActiveVideoContext). */}
    <ActiveVideoProvider>
    <DrawerProvider>
    {/* One shared bottom-bar auto-hide signal for the whole (app) group — the
        BottomBar, the screen FABs and the home/explore headers all read it, and
        it is pinned visible on /videos. Wraps both MainLayout (screens) and the
        BottomBar so every consumer sees the same animated value. */}
    <BottomBarVisibilityProvider>
      <ConnectionStatus />
      <RealtimePostsBridge />
      <MainLayout isScreenNotMobile={isScreenNotMobile} isAuthenticated={isAuthenticated} isAuthResolved={isAuthResolved} />
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
    </BottomBarVisibilityProvider>
    </DrawerProvider>
    </ActiveVideoProvider>
    </VideosRailProvider>
    </ScreenColorProvider>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    // NATIVE pins the scrim with this absolute overlay. WEB pins to the
    // viewport via the `web:fixed web:inset-0 web:z-[2000]` classes on the
    // element (no inline `position: 'fixed'` cast). The shared inset/z values
    // are harmless on web (the web classes own positioning there).
    ...Platform.select({
      web: {},
      default: { position: 'absolute' as const },
    }),
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0, 0, 0, 0.4)',
    zIndex: 2000,
  },
  backdropPressable: {
    ...StyleSheet.absoluteFill,
  },
  drawer: {
    // NATIVE pins the sliding panel with this absolute overlay. WEB pins to
    // the viewport-left edge via the `web:fixed web:left-0 web:top-0
    // web:bottom-0 web:z-[2001]` classes on the (transformed) panel element.
    ...Platform.select({
      web: {},
      default: { position: 'absolute' as const },
    }),
    top: 0,
    left: 0,
    bottom: 0,
    width: 280,
    zIndex: 2001,
  },
});
