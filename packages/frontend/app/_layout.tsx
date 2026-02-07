// Import Reanimated early to ensure proper initialization before other modules
import 'react-native-reanimated';

import NetInfo from '@react-native-community/netinfo';
import { QueryClient, focusManager, onlineManager } from '@tanstack/react-query';
import { useFonts } from "expo-font";
import { Stack } from "expo-router";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { AppState, Platform, type AppStateStatus } from "react-native";
import { useAuth } from '@oxyhq/services';

// Components
import AppSplashScreen from '@/components/AppSplashScreen';
import { NotificationPermissionGate } from '@/components/NotificationPermissionGate';
import { ThemedView } from "@/components/ThemedView";
import { AppProviders } from '@/components/providers/AppProviders';
import { QUERY_CLIENT_CONFIG } from '@/components/providers/constants';
import { Provider as PortalProvider, Outlet as PortalOutlet } from '@/components/Portal';

// Hooks
import { useColorScheme } from "@/hooks/useColorScheme";

// Services & Utils
import { oxyServices } from '@/lib/oxyServices';
import { AppInitializer } from '@/lib/appInitializer';

// Styles
import '../styles/global.css';

// Types
interface SplashState {
  initializationComplete: boolean;
  startFade: boolean;
  fadeComplete: boolean;
}

export default function RootLayout() {
  // State
  const [appIsReady, setAppIsReady] = useState(false);
  const [splashState, setSplashState] = useState<SplashState>({
    initializationComplete: false,
    startFade: false,
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

      return fontMap;
    }, [])
  );

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
      console.error('App initialization failed:', result.error);
      setSplashState((prev) => ({ ...prev, initializationComplete: true }));
    }
  }, [fontsLoaded]);

  // Initialize i18n once when the app mounts
  useEffect(() => {
    AppInitializer.initializeI18n().catch((error) => {
      console.error('Failed to initialize i18n:', error);
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
    if (fontsLoaded && splashState.initializationComplete && !splashState.startFade) {
      setSplashState((prev) => ({ ...prev, startFade: true }));
    }
  }, [fontsLoaded, splashState.initializationComplete, splashState.startFade]);

  useEffect(() => {
    if (splashState.initializationComplete && splashState.fadeComplete && !appIsReady) {
      setAppIsReady(true);
    }
  }, [splashState.initializationComplete, splashState.fadeComplete, appIsReady]);

  const colorScheme = useColorScheme();

  const appContent = useMemo(() => {
    if (!appIsReady) {
      return (
        <AppSplashScreen
          startFade={splashState.startFade}
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
    splashState.startFade,
    splashState.initializationComplete,
    colorScheme,
    handleSplashFadeComplete,
    queryClient,
  ]);

  return (
    <ThemedView style={{ flex: 1 }}>
      {appContent}
    </ThemedView>
  );
}

function AuthRouter() {
  const { isAuthenticated } = useAuth();

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="(app)" redirect={!isAuthenticated} />
      <Stack.Screen name="(auth)" redirect={isAuthenticated} />
    </Stack>
  );
}
