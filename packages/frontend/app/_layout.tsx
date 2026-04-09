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
import { useFonts } from "expo-font";
import { Stack } from "expo-router";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { AppState, Platform, Text, TextInput, useColorScheme as useRNColorScheme, type AppStateStatus } from "react-native";
import { useAuth } from '@oxyhq/services';
import { BloomThemeProvider } from '@oxyhq/bloom/theme';
import { ImageResolverProvider } from '@/lib/imageResolver';

// Components
import AppSplashScreen from '@/components/AppSplashScreen';
import { NotificationPermissionGate } from '@/components/NotificationPermissionGate';
import { ThemedView } from "@/components/ThemedView";
import { AppProviders } from '@/components/providers/AppProviders';
import { QUERY_CLIENT_CONFIG } from '@/components/providers/constants';
import { Provider as PortalProvider, Outlet as PortalOutlet } from '@oxyhq/bloom/portal';

// Hooks
import { useThemeStore } from "@/lib/theme-store";
import { APP_COLOR_PRESETS, getAppColorCSSVariables, applyAppColorToDocument } from "@/lib/app-color-presets";

// Services & Utils
import { oxyServices } from '@/lib/oxyServices';
import { getCachedFileDownloadUrlSync } from '@/utils/imageUrlCache';
import { AppInitializer } from '@/lib/appInitializer';
import { logger } from '@/lib/logger';

// CSS runtime
import { vars } from 'react-native-css';

// Styles
import '../global.css';

// Resolve file IDs to download URLs for Bloom components that call useImageResolver().
function resolveImageSource(fileId: string): string | undefined {
  const url = getCachedFileDownloadUrlSync(oxyServices, fileId, 'thumb');
  return url && url.startsWith('http') ? url : undefined;
}

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

  // Font Loading
  const [fontsLoaded, fontError] = useFonts(
    useMemo(() => {
      const fontMap: Record<string, any> = {};
      const InterVariable = require('@/assets/fonts/inter/InterVariable.ttf');

      ['Thin', 'ExtraLight', 'Light', 'Regular', 'Medium', 'SemiBold', 'Bold', 'ExtraBold', 'Black'].forEach(weight => {
        fontMap[`Inter-${weight}`] = InterVariable;
      });

      // Also register as "Inter" so fontFamily: 'Inter' works everywhere
      fontMap['Inter'] = InterVariable;

      return fontMap;
    }, [])
  );

  // If font loading fails (e.g. corrupt file, 404, wrong format), log the error
  // and treat fonts as "ready" so the app doesn't stay stuck on splash.
  const [fontTimedOut, setFontTimedOut] = useState(false);
  const fontsReady = fontsLoaded || !!fontError || fontTimedOut;

  useEffect(() => {
    if (fontError) {
      logger.error('Font loading failed, proceeding without custom fonts', { error: fontError });
    }
  }, [fontError]);

  // Safety timeout: if fonts haven't loaded after 5 seconds, proceed anyway
  useEffect(() => {
    if (fontsReady) return;
    const timer = setTimeout(() => {
      logger.warn('Font loading timed out after 5s, proceeding without custom fonts');
      setFontTimedOut(true);
    }, 5000);
    return () => clearTimeout(timer);
  }, [fontsReady]);

  // Set Inter as the default font for all Text and TextInput components
  useEffect(() => {
    if (!fontsLoaded) return;
    const defaultTextStyle = { fontFamily: 'Inter' };
    const textProps = (Text as any).defaultProps || {};
    (Text as any).defaultProps = {
      ...textProps,
      style: [textProps.style, defaultTextStyle],
    };
    const textInputProps = (TextInput as any).defaultProps || {};
    (TextInput as any).defaultProps = {
      ...textInputProps,
      style: [textInputProps.style, defaultTextStyle],
    };
  }, [fontsLoaded]);

  // Callbacks
  const handleSplashFadeComplete = useCallback(() => {
    setSplashState((prev) => ({ ...prev, fadeComplete: true }));
  }, []);

  const initializeApp = useCallback(async () => {
    if (!fontsReady) return;

    const result = await AppInitializer.initializeApp(fontsReady, oxyServices);

    if (result.success) {
      setSplashState((prev) => ({ ...prev, initializationComplete: true }));
    } else {
      logger.error('App initialization failed', { error: result.error });
      setSplashState((prev) => ({ ...prev, initializationComplete: true }));
    }
  }, [fontsReady]);

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

  const rnScheme = useRNColorScheme();
  const mode = useThemeStore((s) => s.mode);
  const appColor = useThemeStore((s) => s.appColor);
  const { setMode, setAppColor } = useThemeStore.getState();
  const colorScheme: 'light' | 'dark' =
    (mode === 'adaptive' || mode === 'system')
      ? (rnScheme === 'dark' ? 'dark' : 'light')
      : mode;

  // Apply color preset to web document and compute NativeWind CSS vars for native
  useEffect(() => {
    applyAppColorToDocument(appColor, colorScheme);
  }, [appColor, colorScheme]);

  const colorVars = useMemo(() => {
    const preset = APP_COLOR_PRESETS[appColor];
    return vars(getAppColorCSSVariables(preset, colorScheme));
  }, [appColor, colorScheme]);

  const appContent = useMemo(() => {
    if (!appIsReady) {
      return (
        <AppSplashScreen
          startFade={fontsReady && splashState.initializationComplete}
          onFadeComplete={handleSplashFadeComplete}
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
            initializationComplete={splashState.initializationComplete}
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
    fontsReady,
    splashState.initializationComplete,
    colorScheme,
    handleSplashFadeComplete,
    queryClient,
  ]);

  return (
    <ImageResolverProvider value={resolveImageSource}>
      <BloomThemeProvider
        mode={mode}
        colorPreset={appColor}
        onModeChange={setMode}
        onColorPresetChange={setAppColor}
      >
        <ThemedView style={[{ flex: 1 }, colorVars]}>
          {appContent}
        </ThemedView>
      </BloomThemeProvider>
    </ImageResolverProvider>
  );
}

function AuthRouter() {
  const { isAuthenticated } = useAuth();

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="(auth)" redirect={isAuthenticated} />
      <Stack.Screen name="(app)" />
    </Stack>
  );
}
