// Import Reanimated early to ensure proper initialization before other modules
import 'react-native-reanimated';

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
import { AppInitializer } from '@/lib/appInitializer';
import { logger } from '@/lib/logger';

// CSS runtime
import { vars } from 'react-native-css';

// Styles
import '../global.css';

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
  const queryClient = useMemo(() => new QueryClient(QUERY_CLIENT_CONFIG), []);

  // Font Loading
  const [fontsLoaded] = useFonts(
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
    if (!fontsLoaded) return;

    const result = await AppInitializer.initializeApp(fontsLoaded, oxyServices);

    if (result.success) {
      setSplashState((prev) => ({ ...prev, initializationComplete: true }));
    } else {
      logger.error('App initialization failed', { error: result.error });
      setSplashState((prev) => ({ ...prev, initializationComplete: true }));
    }
  }, [fontsLoaded]);

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
          startFade={fontsLoaded && splashState.initializationComplete}
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
    fontsLoaded,
    splashState.initializationComplete,
    colorScheme,
    handleSplashFadeComplete,
    queryClient,
  ]);

  return (
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
