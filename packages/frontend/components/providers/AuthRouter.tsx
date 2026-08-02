import { Redirect, Slot, Stack, usePathname, useRouter, useSegments } from 'expo-router';
import React, { useEffect } from 'react';
import { Platform } from 'react-native';
import { useAuth } from '@oxyhq/services/ui/client';

import AppSplashScreen from '@/components/AppSplashScreen';
import { useServerAppearanceSync } from '@/hooks/useServerAppearanceSync';
import { useAccountThemeSync } from '@/hooks/useAccountTheme';
import { useSeedViewerFollowStatuses } from '@/hooks/useViewerFollowing';
import { useHydrateExternalEmbeds } from '@/stores/externalEmbedsStore';
import { useShareIntentRouter } from '@/lib/shareIntent';
import { recordWebNavigation } from '@/lib/webTelemetry';

/**
 * The boot gate and the sole authority for the (auth)↔(app) swap.
 *
 * Lives beside the other providers rather than inside `app/_layout.tsx` so the
 * two invariants below can be asserted without dragging in that route module's
 * top-level side effects (reanimated, `enableFreeze`, the splash-hold, logging).
 */
export function AuthRouter() {
  const { isAuthenticated, isAuthResolved } = useAuth();
  const router = useRouter();
  const segments = useSegments();
  const pathname = usePathname();

  useServerAppearanceSync();
  // Drives Bloom from the viewer's portable Oxy account theme when the local
  // source is `account` (rides the cold-boot payload — no extra fetch).
  useAccountThemeSync();
  useHydrateExternalEmbeds();

  // Seed the shared follow store from the viewer's following graph so every
  // FollowButton across the app paints the correct Follow/Following on first
  // render — one request here replaces per-button status probes.
  useSeedViewerFollowStatuses();

  // Forward OS share-sheet payloads into `/compose`. No-op on web
  // (handled by the manifest Share Target).
  useShareIntentRouter({ router, enabled: isAuthResolved && isAuthenticated });

  useEffect(() => {
    recordWebNavigation(pathname);
  }, [pathname]);

  // Routing must not run on unresolved auth — acting early lands the viewer on a
  // blank or wrong route, and this component is the sole authority for the
  // (auth)↔(app) swap. The guard stays; what changes is that WAITING renders the
  // boot visual rather than nothing, so it can never contribute a blank frame.
  // (In the assembled tree `AccountSwitchReset` above normally holds the same
  // window; this keeps the guarantee local rather than inherited.)
  if (!isAuthResolved) {
    return <AppSplashScreen />;
  }

  // WEB: render <Slot/> so the matched route flows in normal document flow (the
  // BODY is the scroller). A native-stack <Stack> clamps each scene in a
  // viewport-height `position: absolute; inset: 0` container, leaving
  // `position: sticky` no taller scroll container to pin within — the rails scroll
  // away. <Slot/> avoids that.
  //
  // <Slot> is the SOLE authority for the (auth)↔(app) swap: reproduce the old root
  // `redirect={isAuthenticated}` declaratively with <Redirect> — authenticated AND
  // inside the (auth) group → bounce to "/". Anonymous users are never redirected
  // away, so public browse keeps working; no competing child redirect on the same
  // signal, so no cold-load race.
  if (Platform.OS === 'web') {
    const inAuthGroup = segments[0] === '(auth)';
    if (isAuthenticated && inAuthGroup) {
      return <Redirect href="/" />;
    }
    return <Slot />;
  }

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="(auth)" redirect={isAuthenticated} />
      <Stack.Screen name="(app)" />
    </Stack>
  );
}
