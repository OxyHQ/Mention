import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { Platform, View, StyleSheet, AppState, AppStateStatus } from 'react-native';
import {
  SafeAreaProvider,
  initialWindowMetrics,
} from 'react-native-safe-area-context';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import * as SplashScreen from 'expo-splash-screen';
import { useFonts } from 'expo-font';
import { Slot } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useIsScreenNotMobile } from '@/hooks/useOptimizedMediaQuery';
import { SideBar } from '@/components/SideBar';
import { RightBar } from '@/components/RightBar';
import { colors } from '@/styles/colors';
import { useKeyboardVisibility } from '@/hooks/useKeyboardVisibility';
import { Toaster } from '@/lib/sonner';
import {
  setupNotifications,
  requestNotificationPermissions,
  scheduleDemoNotification,
} from '@/utils/notifications';
import i18n, { use as i18nUse, init as i18nInit } from 'i18next';
import { initReactI18next, I18nextProvider } from 'react-i18next';
import enUS from '@/locales/en.json';
import esES from '@/locales/es.json';
import itIT from '@/locales/it.json';
import { BottomBar } from '@/components/BottomBar';
import { MenuProvider } from 'react-native-popup-menu';

import AppSplashScreen from '@/components/AppSplashScreen';
import ErrorBoundary from '@/components/ErrorBoundary';
import { BottomSheetProvider } from '@/context/BottomSheetContext';
import { LayoutScrollProvider } from '@/context/LayoutScrollContext';
import { OxyProvider, OxyServices } from '@oxyhq/services';
import '../styles/global.css';
import { OXY_BASE_URL } from '@/config';
import { QueryClient, QueryClientProvider, onlineManager, focusManager } from '@tanstack/react-query';
import NetInfo from '@react-native-community/netinfo';

// i18n will be initialized on app startup inside RootLayout



export default function RootLayout() {
  type SplashState = {
    initializationComplete: boolean;
    startFade: boolean;
  };

  const [appIsReady, setAppIsReady] = useState(false);
  const [splashState, setSplashState] = useState<SplashState>({
    initializationComplete: false,
    startFade: false,
  });
  const isScreenNotMobile = useIsScreenNotMobile();

  const styles = useMemo(() => StyleSheet.create({
    container: {
      ...(isScreenNotMobile ? {
      } : {
        flex: 1,
      }),
      width: '100%',
      marginHorizontal: 'auto',
      flexDirection: isScreenNotMobile ? 'row' : 'column',
    },
    mainContent: {
      maxWidth: 1100,
      marginHorizontal: isScreenNotMobile ? 'auto' : 0,
      justifyContent: 'space-between',
      flexDirection: isScreenNotMobile ? 'row' : 'column',
      flex: 1,
    },
    mainContentWrapper: {
      flex: isScreenNotMobile ? 2.2 : 1,
      ...(isScreenNotMobile ? {
        borderLeftWidth: 0.5,
        borderRightWidth: 0.5,
        borderColor: '#0d0d0d0d',
      } : {}),
      backgroundColor: colors.primaryLight,
    },
  }), [isScreenNotMobile]);
  // layout scroll is now handled inside LayoutScrollProvider
  const queryClient = useMemo(() => new QueryClient({
    defaultOptions: {
      queries: {
        retry: 2,
        staleTime: 1000 * 30,
        gcTime: 1000 * 60 * 10,
        refetchOnReconnect: true,
        refetchOnWindowFocus: true,
      },
    },
  }), []);

  // --- Font Loading ---
  const [loaded] = useFonts({
    // ... keep Inter and Phudu fonts for fallback or legacy
    'Inter-Black': require('@/assets/fonts/inter/Inter-Black.otf'),
    'Inter-Bold': require('@/assets/fonts/inter/Inter-Bold.otf'),
    'Inter-ExtraBold': require('@/assets/fonts/inter/Inter-ExtraBold.otf'),
    'Inter-ExtraLight': require('@/assets/fonts/inter/Inter-ExtraLight.otf'),
    'Inter-Light': require('@/assets/fonts/inter/Inter-Light.otf'),
    'Inter-Medium': require('@/assets/fonts/inter/Inter-Medium.otf'),
    'Inter-Regular': require('@/assets/fonts/inter/Inter-Regular.otf'),
    'Inter-SemiBold': require('@/assets/fonts/inter/Inter-SemiBold.otf'),
    'Inter-Thin': require('@/assets/fonts/inter/Inter-Thin.otf'),
    'Phudu-Thin': require('@/assets/fonts/Phudu-VariableFont_wght.ttf'),
    'Phudu-Regular': require('@/assets/fonts/Phudu-VariableFont_wght.ttf'),
    'Phudu-Medium': require('@/assets/fonts/Phudu-VariableFont_wght.ttf'),
    'Phudu-SemiBold': require('@/assets/fonts/Phudu-VariableFont_wght.ttf'),
    'Phudu-Bold': require('@/assets/fonts/Phudu-VariableFont_wght.ttf'),
  });

  // --- Keyboard State ---
  const keyboardVisible = useKeyboardVisibility();

  const oxyServices = useMemo(() => new OxyServices({ baseURL: OXY_BASE_URL }), []);
  // Helper: call runtime waitForAuth if available on the OxyServices instance
  const waitForAuth = useCallback(async (services: OxyServices, timeoutMs = 5000) => {
    const maybe = services as unknown as { waitForAuth?: (ms?: number) => Promise<boolean> };
    if (typeof maybe.waitForAuth === 'function') {
      try {
        return await maybe.waitForAuth(timeoutMs);
      } catch (e) {
        console.warn('waitForAuth failed:', e);
        return false;
      }
    }
    return false;
  }, []);

  const initializeApp = useCallback(async () => {
    if (!loaded) return;

    try {
      if (Platform.OS !== 'web') {
        await setupNotifications();
        const hasPermission = await requestNotificationPermissions();
        if (hasPermission && __DEV__) {
          await scheduleDemoNotification();
        }
      }

      // Wait briefly for auth to be ready and warm up current user cache if possible.
      const authReady = await waitForAuth(oxyServices, 5000);
      if (authReady) {
        try {
          await oxyServices.getCurrentUser();
        } catch (err) {
          console.warn('Failed to fetch current user during init:', err);
        }
      }

      setSplashState((prev) => ({ ...prev, initializationComplete: true }));

      try {
        await SplashScreen.hideAsync();
      } catch (err) {
        console.warn('Failed to hide native splash screen:', err);
      }
    } catch (error) {
      console.warn('Failed to initialize app:', error);
    }
  }, [loaded, oxyServices, waitForAuth]);

  // Initialize i18n once when the app mounts
  useEffect(() => {
    try {
      i18nUse(initReactI18next);
      i18nInit({
        resources: {
          'en-US': { translation: enUS },
          'es-ES': { translation: esES },
          'it-IT': { translation: itIT },
        },
        lng: 'en-US',
        fallbackLng: 'en-US',
        interpolation: { escapeValue: false },
      }).catch((error: unknown) => console.error('Failed to initialize i18n:', error));
    } catch (err) {
      console.error('i18n setup failed:', err);
    }
  }, []);

  // --- Splash Fade Handler ---
  const handleSplashFadeComplete = useCallback(() => {
    setAppIsReady(true);
  }, []);

  // Alias GestureHandlerRootView to a permissive component type to avoid children typing issues
  const GestureRoot = GestureHandlerRootView as unknown as React.ComponentType<any>;

  useEffect(() => {
    // React Query online manager using NetInfo
    const unsubscribeNetInfo = NetInfo.addEventListener((state) => {
      onlineManager.setOnline(Boolean(state.isConnected && state.isInternetReachable !== false));
    });

    // React Query focus manager using AppState
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
    if (loaded && splashState.initializationComplete && !splashState.startFade) {
      setSplashState((prev) => ({ ...prev, startFade: true }));
    }
  }, [loaded, splashState.initializationComplete, splashState.startFade]);

  return (
    <View style={{ flex: 1 }}>
      <SafeAreaProvider initialMetrics={initialWindowMetrics}>
        <GestureRoot style={{ flex: 1 }}>
          {appIsReady ? (
            <QueryClientProvider client={queryClient}>
              <OxyProvider
                oxyServices={oxyServices}
                initialScreen="SignIn"
                autoPresent={false}
                storageKeyPrefix="oxy_example"
                theme="light"
              >
                <I18nextProvider i18n={i18n}>
                  <BottomSheetProvider>
                    <MenuProvider>
                      <ErrorBoundary>
                        <LayoutScrollProvider
                          contentContainerStyle={styles.container}
                          style={{ flex: 1 }}
                          scrollEventThrottle={16}
                        >
                          <SideBar />
                          <View style={styles.mainContent}>
                            <View style={styles.mainContentWrapper}>
                              <Slot />
                            </View>
                            <RightBar />
                          </View>
                        </LayoutScrollProvider>
                        <StatusBar style="auto" />
                        <Toaster
                          position="bottom-center"
                          swipeToDismissDirection="left"
                          offset={15}
                        />
                        {!isScreenNotMobile && !keyboardVisible && <BottomBar />}
                      </ErrorBoundary>
                    </MenuProvider>
                  </BottomSheetProvider>
                </I18nextProvider>
              </OxyProvider>
            </QueryClientProvider>
          ) : (
            <AppSplashScreen
              startFade={splashState.startFade}
              onFadeComplete={handleSplashFadeComplete}
            />
          )}
        </GestureRoot>
      </SafeAreaProvider>
    </View>
  );
}
