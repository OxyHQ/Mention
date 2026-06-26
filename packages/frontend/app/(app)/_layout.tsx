import React, { useCallback, useEffect, useState, memo } from "react";
import { Platform, Pressable, StyleSheet, View } from "react-native";
import { Slot, Stack, usePathname } from "expo-router";
import Animated, { interpolate, useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";

import { useAuth } from '@oxyhq/services';
import { useTheme } from '@oxyhq/bloom/theme';

import { BottomBar, BOTTOM_BAR_RESERVED_SPACE } from "@/components/BottomBar";
import KeyboardShortcutsModal from "@/components/KeyboardShortcutsModal";
import RegisterPush from '@/components/RegisterPushToken';
import { RealtimePostsBridge } from '@/components/RealtimePostsBridge';
import { RightBar } from "@/components/RightBar";
import { SideBar } from "@/components/SideBar";
import { SignInBanner } from "@/components/SignInBanner";
import { ThemedView } from "@/components/ThemedView";
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
import { APP_COLOR_PRESETS, BloomColorScope, type AppColorName } from '@oxyhq/bloom/theme';
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

/** Spread (px) of the gutter-color mask painted around the rounded center frame. */
const GUTTER_MASK_SPREAD = 40;

const MainLayout: React.FC<MainLayoutProps & { isAuthenticated: boolean; isAuthResolved: boolean }> = memo(({ isScreenNotMobile, isAuthenticated, isAuthResolved }) => {
  const { screenColor } = useScreenColor();
  const theme = useTheme();
  const pathname = usePathname();
  const insets = useSafeAreaInsets();
  const onProfileRoute = isProfileRoute(pathname);

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
        style={isScreenNotMobile ? { maxWidth: 950, flexShrink: 1 } : undefined}
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
          <ThemedView
            className={cn(
              "flex-1 bg-background",
              // WEB must NOT create an overflow context on the center column —
              // overflow-hidden there would clip the document scroll and the
              // sticky frame. Native keeps overflow-hidden + the side borders.
              !IS_WEB && "overflow-hidden",
              !IS_WEB && isScreenNotMobile && "border-x border-border",
              // Desktop web: rounded card panel floating inside the gutter
              // wrapper (full-bleed below the sidebar breakpoint / mobile). The
              // panel surface (`bg-card` + `rounded-[28px]`) lives here, but it
              // has NO border —
              // the single continuous rounded border is owned by ONE frame
              // overlay painted ABOVE all content (see below). Putting a border
              // here too would double the line / leave seams where the opaque
              // header & banner cover the panel's own top/bottom edge. (The
              // feed-clipping `overflow-x-clip` is NOT here — it lives on the
              // feed-content wrapper around `centerContent` so it never clips the
              // sticky mask/border overlays' gutter box-shadow, mirroring how
              // Mercaria puts overflow-x-clip on the content panel, not the
              // frame.)
              IS_WEB && isScreenNotMobile && "rounded-[28px] bg-card",
            )}
          >
            {/* Two SEPARATE desktop-web overlays (rendered only when
                `isScreenNotMobile` — the SAME >=500px breakpoint that shows the
                sidebar + gutter margins, so the frame never diverges from them),
                both STICKY to the viewport with ~0 layout height (negative bottom
                margin) so they frame the column without pushing content, and both
                `pointer-events-none`. Conceptually split per the design:

                (1) BLEED MASK — z-30, BELOW the chrome. Its `boxShadow` paints a
                    ring of the GUTTER color (Bloom `background` token, never a
                    hex) over FEED content that bleeds into the thin lateral
                    gutter / rounded corners. `clip-path: inset(-12px)` keeps that
                    ring off the side columns. It sits below the opaque header
                    (bg-card) and banner so it only masks the FEED's bleed, never
                    the chrome. No border. (`clipPath` MUST be the arbitrary class
                    — RN-web drops it from the style object.)

                (2) BORDER FRAME — z-[120], ABOVE everything (feed z-0, mask z-30,
                    tab bar z-100, header z-101, banner z-110). It is JUST the 1px
                    rounded `border-border` outline, transparent interior. Being a
                    single element above all content, it draws ONE continuous
                    rounded border around all four sides of the panel — no seams,
                    no double lines, no per-chrome borders. The border is owned
                    SOLELY by the container, exactly as requested. */}
            {IS_WEB && isScreenNotMobile && (
              <>
                <View
                  pointerEvents="none"
                  className="web:sticky web:top-2 z-30 h-[calc(100dvh-16px)] w-full rounded-[28px] web:[margin-bottom:calc(-100dvh+16px)] web:[clip-path:inset(-12px)]"
                  style={{ boxShadow: `0 0 0 ${GUTTER_MASK_SPREAD}px ${theme.colors.background}` }}
                />
                <View
                  pointerEvents="none"
                  className="web:sticky web:top-2 z-[120] h-[calc(100dvh-16px)] w-full rounded-[28px] border border-border web:[margin-bottom:calc(-100dvh+16px)]"
                />
              </>
            )}
            {/* Feed-content wrapper. On desktop web it carries `overflow-x-clip`
                + the matching rounded corners so the feed (and any card) is
                clipped to the rounded panel shape — content can never poke past
                the corners/sides (mirrors Mercaria's content panel). `clip`
                (NOT hidden/auto) clips the bleed WITHOUT creating a scroll
                container or promoting the vertical axis, so the document scroll
                and the descendants' `position: sticky` (header, banner) stay
                intact. It is SEPARATE from the sticky mask/border overlays above
                so their gutter box-shadow is never clipped. `flex-1` fills the
                panel. */}
            <View
              className={cn(
                "flex-1",
                IS_WEB && isScreenNotMobile && "rounded-[28px] web:overflow-x-clip",
              )}
              style={mobileWebBottomInset ? { paddingBottom: mobileWebBottomInset } : undefined}
            >
              {centerContent}
            </View>
          </ThemedView>
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
