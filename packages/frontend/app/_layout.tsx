// Import Reanimated early to ensure proper initialization before other modules
import 'react-native-reanimated';

// Freeze inactive (blurred) screens app-wide. Combined with `freezeOnBlur: true`
// on the (app) Stack, screens that the user navigates away from stay MOUNTED
// (retaining their state + scroll position) but have their JS/render work paused
// until they regain focus. This is what lets feed → /videos → back restore the
// exact feed scroll position natively, Instagram-style. Must run once at module
// scope, before any navigator mounts.
import { enableFreeze } from 'react-native-screens';
enableFreeze(true);

// Suppress known React Native Web warning about text nodes in Views.
// The React Compiler (Hermes) can produce stray punctuation string children in
// compiled JSX (e.g. a literal ".") which triggers a harmless dev-only
// console.error in RNW's View component.  LogBox.ignoreLogs hides the overlay
// but the console.error still fires, so we also patch console.error itself.
import { LogBox } from 'react-native';
LogBox.ignoreLogs(['Unexpected text node: . A text node cannot be a child of a <View>.']);

if (__DEV__) {
  const origConsoleError = console.error;
  console.error = (...args: unknown[]) => {
    if (
      typeof args[0] === 'string' &&
      args[0].startsWith('Unexpected text node: ') &&
      args[0].includes('A text node cannot be a child of a <View>')
    ) {
      return; // swallow harmless React Compiler + RNW noise
    }
    origConsoleError.apply(console, args);
  };
}

// Register LiveKit WebRTC globals (must be called before any LiveKit usage)
// Platform-split: livekit.native.ts imports @livekit/react-native, livekit.web.ts is a no-op
import { initLiveKit } from '@/lib/livekit';
initLiveKit();

import NetInfo from '@react-native-community/netinfo';
import { focusManager, onlineManager } from '@tanstack/react-query';
import { Redirect, Slot, Stack, useRouter, useSegments } from "expo-router";
import * as SplashScreen from 'expo-splash-screen';
import React, { useCallback, useEffect, useState } from "react";
import { AppState, Platform, type AppStateStatus } from "react-native";
import { useAuth } from '@oxyhq/services';
import { BloomThemeProvider } from '@oxyhq/bloom/theme';
import { ImageResolverProvider } from '@oxyhq/bloom/image-resolver';

// Components
import AppSplashScreen from '@/components/AppSplashScreen';
import { NotificationPermissionGate } from '@/components/NotificationPermissionGate';
import { AppProviders } from '@/components/providers/AppProviders';
import { Provider as PortalProvider, Outlet as PortalOutlet } from '@oxyhq/bloom/portal';

// Hooks
import { useServerAppearanceSync } from '@/hooks/useServerAppearanceSync';
import { useHydrateExternalEmbeds } from '@/stores/externalEmbedsStore';

// Services & Utils
import { oxyServices } from '@/lib/oxyServices';
import { queryClient } from '@/lib/queryClient';
import { getCachedFileDownloadUrlSync } from '@/utils/imageUrlCache';
import { AppInitializer } from '@/lib/appInitializer';
import { logger } from '@/lib/logger';
import { useShareIntentRouter } from '@/lib/shareIntent';
import { BLOOM_THEME_PERSIST_KEY, BLOOM_THEME_STORAGE } from '@/lib/themePersistence';

// Styles
import '../global.css';

// NATIVE ONLY: hold the OS splash screen so it stays visible until the app has
// finished loading fonts + running init, then we hide it in `RootLayout` once
// `appIsReady` flips. This makes the native OS splash the SINGLE splash on
// native (Mention logo centered + Oxy branding at the bottom, configured via the
// `expo-splash-screen` plugin in app.config.js). The custom `AppSplashScreen`
// React overlay is gated to web only. On web this call is unnecessary/noisy, so
// it is skipped. `preventAutoHideAsync` can reject if called too late, so we
// swallow that — a failure here just means the OS splash hides at the first JS
// frame, which the web-only custom splash never depends on.
if (Platform.OS !== 'web') {
  SplashScreen.preventAutoHideAsync().catch(() => {});
}

// Resolve file IDs to download URLs for Bloom components that call useImageResolver().
// Honors the rendition `variant` Bloom forwards (e.g. 'thumb' for list/grid
// avatars, a larger rendition for detail headers); defaults to 'thumb' when a
// caller omits it so small avatars stay light by default.
function resolveImageSource(fileId: string, variant?: string): string | undefined {
  const url = getCachedFileDownloadUrlSync(oxyServices, fileId, variant ?? 'thumb');
  return url && url.startsWith('http') ? url : undefined;
}

interface SplashState {
  initializationComplete: boolean;
  fadeComplete: boolean;
}

export default function RootLayout() {
  // State
  const [appIsReady, setAppIsReady] = useState(false);
  const [splashState, setSplashState] = useState<SplashState>({
    initializationComplete: false,
    fadeComplete: false,
  });

  // Callbacks
  const handleSplashFadeComplete = useCallback(() => {
    setSplashState((prev) => ({ ...prev, fadeComplete: true }));
  }, []);

  const initializeApp = useCallback(async () => {
    const result = await AppInitializer.initializeApp(true);

    if (result.success) {
      setSplashState((prev) => ({ ...prev, initializationComplete: true }));
    } else {
      logger.error('App initialization failed', { error: result.error });
      setSplashState((prev) => ({ ...prev, initializationComplete: true }));
    }
  }, []);

  // Initialize i18n once when the app mounts
  useEffect(() => {
    AppInitializer.initializeI18n().catch((error) => {
      logger.error('Failed to initialize i18n', { error });
    });
  }, []);

  // React Query managers - setup once on mount
  useEffect(() => {
    const unsubscribeNetInfo = NetInfo.addEventListener((state) => {
      onlineManager.setOnline(Boolean(state.isConnected && state.isInternetReachable !== false));
    });

    const onAppStateChange = (status: AppStateStatus) => {
      focusManager.setFocused(status === 'active');
    };
    const appStateSub = AppState.addEventListener('change', onAppStateChange);

    return () => {
      unsubscribeNetInfo();
      appStateSub.remove();
    };
  }, []);

  useEffect(() => {
    initializeApp();
  }, [initializeApp]);

  // Readiness gate.
  // - WEB keeps the fade-gated flow: the custom <AppSplashScreen> is rendered,
  //   fades out when init completes, and its `onFadeComplete` sets `fadeComplete`.
  //   So web readiness = init complete AND the custom splash has finished fading.
  // - NATIVE renders NO custom splash (the held OS splash covers the screen), so
  //   `onFadeComplete` never fires and readiness must NOT depend on `fadeComplete`.
  //   Native readiness = init complete (fonts are gated separately by
  //   BloomThemeProvider's `onFontsLoading`, which renders the held OS splash's
  //   backdrop — null — on native).
  useEffect(() => {
    if (appIsReady) return;
    const ready =
      Platform.OS === 'web'
        ? splashState.initializationComplete && splashState.fadeComplete
        : splashState.initializationComplete;
    if (ready) {
      setAppIsReady(true);
    }
  }, [splashState.initializationComplete, splashState.fadeComplete, appIsReady]);

  // NATIVE ONLY: once the app is ready to render real UI, hide the held OS splash.
  // Because the OS splash stayed up until this exact moment, there is no blank gap
  // between it and the first real frame. On web this is a no-op (the OS splash was
  // never held; the custom overlay handles the transition).
  useEffect(() => {
    if (appIsReady && Platform.OS !== 'web') {
      SplashScreen.hideAsync().catch(() => {});
    }
  }, [appIsReady]);

  return (
    <ImageResolverProvider value={resolveImageSource}>
      <BloomThemeProvider
        defaultMode="system"
        defaultColorPreset="blue"
        persistKey={BLOOM_THEME_PERSIST_KEY}
        storage={BLOOM_THEME_STORAGE}
        // WEB shows the custom splash while fonts load; NATIVE shows nothing here
        // because the held OS splash is already covering the screen.
        onFontsLoading={Platform.OS === 'web' ? <AppSplashScreen /> : null}
      >
        <AppProviders oxyServices={oxyServices} queryClient={queryClient}>
          {appIsReady ? (
            <>
            {Platform.OS !== 'web' && (
              <NotificationPermissionGate
                appIsReady={appIsReady}
                initializationComplete={splashState.initializationComplete}
              />
            )}
            <PortalProvider>
              <AuthRouter />
              <PortalOutlet />
            </PortalProvider>
            </>
          ) : Platform.OS === 'web' ? (
            // WEB: the custom splash covers font-load + init and fades out; its
            // `onFadeComplete` gates `appIsReady`. NATIVE renders null here — the
            // held OS splash is on top, so nothing underneath needs to paint.
            <AppSplashScreen
              startFade={splashState.initializationComplete}
              onFadeComplete={handleSplashFadeComplete}
            />
          ) : null}
        </AppProviders>
      </BloomThemeProvider>
    </ImageResolverProvider>
  );
}

function AuthRouter() {
  const { isAuthenticated, isAuthResolved } = useAuth();
  const router = useRouter();
  const segments = useSegments();

  useServerAppearanceSync();
  useHydrateExternalEmbeds();

  // Forward OS share-sheet payloads into `/compose`. No-op on web
  // (handled by the manifest Share Target).
  useShareIntentRouter({ router, enabled: isAuthResolved && isAuthenticated });

  if (!isAuthResolved) {
    return null;
  }

  // WEB: render <Slot/> so the matched group/route flows in normal document
  // flow (the BODY is the scroller). A native-stack <Stack> wraps each scene in
  // a `position: absolute; inset: 0` container clamped to the viewport height,
  // which sits above the (app) group and gives `position: sticky` no taller
  // scroll container to pin within — the rails scroll away. <Slot/> avoids that
  // absolute, viewport-clamped scene wrapper.
  //
  // The root <Stack> was the sole authority for the (auth)↔(app) swap via
  // `redirect={isAuthenticated}` (an authenticated user can never sit on an
  // (auth) route). We reproduce that EXACT behavior declaratively with
  // <Redirect>: when authenticated AND currently inside the (auth) group, bounce
  // to "/". Anonymous users are never redirected away from (app), so public
  // browse keeps working. There is no competing child redirect on the same
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
