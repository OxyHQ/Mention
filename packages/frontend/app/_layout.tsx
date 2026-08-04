// Import Reanimated early so it initializes before other modules.
import 'react-native-reanimated';
import { enableFreeze } from 'react-native-screens';
import { registerChunkErrorRecovery } from '@/lib/chunkReload';
import NetInfo from '@react-native-community/netinfo';
import { focusManager, onlineManager } from '@tanstack/react-query';
import * as SplashScreen from 'expo-splash-screen';
import React, { useCallback, useEffect, useState } from "react";
import { AppState, Platform, type AppStateStatus } from "react-native";
import { BloomProvider } from '@oxyhq/bloom/provider';

// Components
import AppSplashScreen from '@/components/AppSplashScreen';
import { NotificationPermissionGate } from '@/components/NotificationPermissionGate';
import { PwaHead } from '@/components/PwaHead';
import { AppProviders } from '@/components/providers/AppProviders';
import { AuthRouter } from '@/components/providers/AuthRouter';
import { Provider as PortalProvider, Outlet as PortalOutlet } from '@oxyhq/bloom/portal';

// Hooks
import { useHapticsStore } from '@/stores/hapticsStore';

// Services & Utils
import { oxyServices } from '@/lib/oxyServices';
import { queryClient } from '@/lib/queryClient';
import { getCachedFileDownloadUrlSync } from '@/utils/imageUrlCache';
import { MEDIA_VARIANT_AVATAR } from '@mention/shared-types/post';
import { AppInitializer } from '@/lib/appInitializer';
import { logger } from '@oxyhq/core/logger';
import { configureAppLogging } from '@/lib/logging';
import { BLOOM_THEME_PERSIST_KEY, BLOOM_THEME_STORAGE } from '@/lib/themePersistence';
import { registerSocketBfcacheRelease } from '@/lib/socketBfcache';
import { initializeWebTelemetry } from '@/lib/webTelemetry';

// Styles
import '../global.css';

// Install the app's level + scrubbing sink on the shared SDK logger before any
// route can emit a line.
configureAppLogging();

// Freeze blurred screens so their state and scroll position survive navigation,
// and register web chunk recovery before the first route can lazy-load.
enableFreeze(true);
registerChunkErrorRecovery();

// NATIVE ONLY: hold the OS splash until `appIsReady` flips (hidden in RootLayout),
// making the held OS splash the single native splash; the custom <AppSplashScreen>
// overlay is web-only. Skipped on web. `preventAutoHideAsync` may reject if called
// too late — swallow it (the OS splash then just hides at the first JS frame).
if (Platform.OS !== 'web') {
  SplashScreen.preventAutoHideAsync().catch(() => {});
}

// Resolve file IDs → download URLs for Bloom's useImageResolver(). Honors the
// rendition `variant` a caller forwards. This resolver is AVATAR-ONLY in practice
// — its only consumers are Bloom's <Avatar>/<AvatarGroup> and <ZoomableAvatar>
// (post media, banners and link previews resolve through their own dedicated
// getFileDownloadUrl paths). When a caller omits `variant`, default to the 128px
// square `avatar` crop (MEDIA_VARIANT_AVATAR) so bare-id avatars stay light.
// Larger avatars (profile header, settings) request an explicit heavier variant
// at their call site rather than relying on this default, so they are never
// shrunk here. NOTE: Bloom's <Avatar> supplies its own `variant` default, so most
// small avatars must ALSO pass an explicit variant={MEDIA_VARIANT_AVATAR} — this
// default only covers direct useImageResolver callers that omit it.
function resolveImageSource(fileId: string, variant?: string): string | undefined {
  const url = getCachedFileDownloadUrlSync(oxyServices, fileId, variant ?? MEDIA_VARIANT_AVATAR);
  return url && url.startsWith('http') ? url : undefined;
}

interface SplashState {
  initializationComplete: boolean;
  fadeComplete: boolean;
}

export default function RootLayout() {
  // State
  const [appIsReady, setAppIsReady] = useState(false);
  // Global haptics on/off, persisted via the accessibility settings toggle. Passed
  // to <BloomProvider haptics> so every useHaptics() call honors the preference.
  const hapticsDisabled = useHapticsStore((s) => s.disabled);
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
      logger.error('App initialization failed', result.error);
      setSplashState((prev) => ({ ...prev, initializationComplete: true }));
    }
  }, []);

  // Initialize i18n once when the app mounts
  useEffect(() => {
    AppInitializer.initializeI18n().catch((error) => {
      logger.error('Failed to initialize i18n', error);
    });
  }, []);

  useEffect(() => initializeWebTelemetry(), []);

  // Release the realtime sockets while the browser holds this document in its
  // back/forward cache — an open WebSocket makes the page ineligible, which is
  // what turns a cross-document Back into a full app reload.
  useEffect(() => registerSocketBfcacheRelease(), []);

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

  // Readiness gate. WEB: init complete AND the custom <AppSplashScreen> has finished
  // fading (its `onFadeComplete` sets `fadeComplete`). NATIVE: init complete only —
  // there is no custom splash (the held OS splash covers the screen) so
  // `onFadeComplete` never fires; fonts are gated separately by BloomThemeProvider.
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

  // NATIVE ONLY: hide the held OS splash once ready — it stayed up until this exact
  // moment, so there is no blank gap before the first real frame. No-op on web.
  useEffect(() => {
    if (appIsReady && Platform.OS !== 'web') {
      SplashScreen.hideAsync().catch(() => {});
    }
  }, [appIsReady]);

  return (
    <>
      {/* WEB-only: inject the PWA manifest <link> + apple/theme metas into
          document.head at runtime (installability + Web Share Target). Mounted at
          the root so it is present on every page; renders nothing. No-op on native.
          Sits OUTSIDE <BloomProvider> on purpose: the theme provider gates its
          children while fonts load, and the manifest must not wait for that. */}
      <PwaHead />
      {/* The single Bloom root — theme + haptics + image resolution + scroll
          restoration + tab-bar minimize progress. Everything Bloom renders must be
          under it: on web `useScrollRestoration()` throws outside its provider, so
          a scrollable mounted beside it (a right rail, an overlay) crashes. */}
      <BloomProvider
        // TEMPORARY: colour-policy preview. Remove with `components/dev/` and
        // the `.bloom-local` symlink once the colour system lands upstream.
        imageResolver={resolveImageSource}
        haptics={!hapticsDisabled}
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
      </BloomProvider>
    </>
  );
}
