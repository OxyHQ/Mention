// Import Reanimated early to ensure proper initialization before other modules
import 'react-native-reanimated';

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
import { QueryClient, focusManager, onlineManager } from '@tanstack/react-query';
import { Stack, useRouter } from "expo-router";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { AppState, Platform, useColorScheme as useRNColorScheme, type AppStateStatus } from "react-native";
import { useAuth } from '@oxyhq/services';
import { BloomThemeProvider, useBloomTheme, webLocalStorage, type BloomThemeStorage } from '@oxyhq/bloom/theme';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { ImageResolverProvider } from '@/lib/imageResolver';

// Components
import AppSplashScreen from '@/components/AppSplashScreen';
import { NotificationPermissionGate } from '@/components/NotificationPermissionGate';
import { ThemedView } from "@/components/ThemedView";
import { AppProviders } from '@/components/providers/AppProviders';
import { QUERY_CLIENT_CONFIG } from '@/components/providers/constants';
import { Provider as PortalProvider, Outlet as PortalOutlet } from '@oxyhq/bloom/portal';

// Hooks
import { APP_COLOR_PRESETS, getAppColorCSSVariables } from "@/lib/app-color-presets";
import { registerAppearanceThemeBridge } from '@/store/appearanceStore';

// Services & Utils
import { oxyServices } from '@/lib/oxyServices';
import { getCachedFileDownloadUrlSync } from '@/utils/imageUrlCache';
import { AppInitializer } from '@/lib/appInitializer';
import { logger } from '@/lib/logger';
import { useShareIntentRouter } from '@/lib/shareIntent';

// CSS runtime
import { vars } from 'react-native-css';

// Styles
import '../global.css';

// Resolve file IDs to download URLs for Bloom components that call useImageResolver().
function resolveImageSource(fileId: string): string | undefined {
  const url = getCachedFileDownloadUrlSync(oxyServices, fileId, 'thumb');
  return url && url.startsWith('http') ? url : undefined;
}

// AsyncStorage-backed adapter for Bloom theme persistence on native.
const asyncStorageAdapter: BloomThemeStorage = {
  getItem: (key) => AsyncStorage.getItem(key),
  setItem: (key, value) => AsyncStorage.setItem(key, value),
};

const themeStorage: BloomThemeStorage | undefined =
  Platform.OS === 'web' ? webLocalStorage : asyncStorageAdapter;

// Types
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

  // Memoized instances
  // Stable QueryClient (single instance app-wide)
  const queryClient = useMemo(() => new QueryClient(QUERY_CLIENT_CONFIG), []);

  // Callbacks
  const handleSplashFadeComplete = useCallback(() => {
    setSplashState((prev) => ({ ...prev, fadeComplete: true }));
  }, []);

  const initializeApp = useCallback(async () => {
    const result = await AppInitializer.initializeApp(true, oxyServices);

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

  useEffect(() => {
    if (splashState.initializationComplete && splashState.fadeComplete && !appIsReady) {
      setAppIsReady(true);
    }
  }, [splashState.initializationComplete, splashState.fadeComplete, appIsReady]);

  return (
    <ImageResolverProvider value={resolveImageSource}>
      <BloomThemeProvider
        defaultMode="system"
        defaultColorPreset="blue"
        persistKey="mention-theme"
        storage={themeStorage}
        onFontsLoading={<AppSplashScreen />}
        onHydrating={<AppSplashScreen />}
      >
        <ThemedRoot
          appIsReady={appIsReady}
          initializationComplete={splashState.initializationComplete}
          onSplashFadeComplete={handleSplashFadeComplete}
          queryClient={queryClient}
        />
      </BloomThemeProvider>
    </ImageResolverProvider>
  );
}

interface ThemedRootProps {
  appIsReady: boolean;
  initializationComplete: boolean;
  onSplashFadeComplete: () => void;
  queryClient: QueryClient;
}

function ThemedRoot({
  appIsReady,
  initializationComplete,
  onSplashFadeComplete,
  queryClient,
}: ThemedRootProps) {
  const rnScheme = useRNColorScheme();
  const { mode, colorPreset, setMode, setColorPreset } = useBloomTheme();

  // Bridge server-side appearance settings into Bloom's theme provider.
  useEffect(() => {
    registerAppearanceThemeBridge({ setMode, setColorPreset });
    return () => registerAppearanceThemeBridge(null);
  }, [setMode, setColorPreset]);

  const colorScheme: 'light' | 'dark' =
    mode === 'adaptive' || mode === 'system'
      ? rnScheme === 'dark' ? 'dark' : 'light'
      : mode;

  // Compute NativeWind CSS vars for native. On web, BloomThemeProvider is the
  // authoritative writer of these CSS variables on document.documentElement.
  const colorVars = useMemo(() => {
    const preset = APP_COLOR_PRESETS[colorPreset];
    return vars(getAppColorCSSVariables(preset, colorScheme));
  }, [colorPreset, colorScheme]);

  const appContent = useMemo(() => {
    if (!appIsReady) {
      return (
        <AppSplashScreen
          startFade={initializationComplete}
          onFadeComplete={onSplashFadeComplete}
        />
      );
    }

    return (
      <AppProviders
        oxyServices={oxyServices}
        colorScheme={colorScheme}
        queryClient={queryClient}
      >
        {Platform.OS !== 'web' && (
          <NotificationPermissionGate
            appIsReady={appIsReady}
            initializationComplete={initializationComplete}
          />
        )}
        <PortalProvider>
          <AuthRouter />
          <PortalOutlet />
        </PortalProvider>
      </AppProviders>
    );
  }, [
    appIsReady,
    initializationComplete,
    colorScheme,
    onSplashFadeComplete,
    queryClient,
  ]);

  return (
    <ThemedView style={[{ flex: 1 }, colorVars]}>
      {appContent}
    </ThemedView>
  );
}

function AuthRouter() {
  const { isAuthenticated } = useAuth();
  const router = useRouter();

  // Forward OS share-sheet payloads into `/compose`. No-op on web
  // (handled by the manifest Share Target).
  useShareIntentRouter({ router, enabled: isAuthenticated });

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="(auth)" redirect={isAuthenticated} />
      <Stack.Screen name="(app)" />
    </Stack>
  );
}
