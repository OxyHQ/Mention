import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { Platform, View, StyleSheet, Animated, AppState, AppStateStatus } from 'react-native';
import {
  SafeAreaProvider,
  initialWindowMetrics,
} from 'react-native-safe-area-context';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import * as SplashScreen from 'expo-splash-screen';
import { useFonts } from 'expo-font';
import { Slot, usePathname } from 'expo-router';
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
import { PostHogProvider } from 'posthog-react-native';
import '../styles/global.css';
import { OXY_BASE_URL } from '@/config';
import { QueryClient, QueryClientProvider, onlineManager, focusManager } from '@tanstack/react-query';
import NetInfo from '@react-native-community/netinfo';

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
})
  .catch((error: unknown) => {
    console.error('Failed to initialize i18n:', error);
  });



export default function RootLayout() {
  const [appIsReady, setAppIsReady] = useState(false);
  const [splashState, setSplashState] = useState({
    initializationComplete: false,
    startFade: false,
  });
  const isScreenNotMobile = useIsScreenNotMobile();
  const pathname = usePathname() || '/';

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
  const posthogApiKey = process.env.EXPO_PUBLIC_POSTHOG_KEY || 'phc_wRxFcPEaeeRHAKoMi4gzleLdNE9Ny4JEwYe8Z5h3soO';
  const posthogHost = process.env.EXPO_PUBLIC_POSTHOG_HOST || 'https://us.i.posthog.com';
  const layoutScrollY = useMemo(() => new Animated.Value(0), []);
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

  const initializeApp = useCallback(async () => {
    try {
      if (loaded) {
        if (Platform.OS !== 'web') {
          await setupNotifications();
          const hasPermission = await requestNotificationPermissions();
          if (hasPermission && __DEV__) {
            await scheduleDemoNotification();
          }
        }
        setSplashState((prev) => ({ ...prev, initializationComplete: true }));
        await SplashScreen.hideAsync();
      }
    } catch (error) {
      console.warn('Failed to set up notifications:', error);
    }
  }, [loaded]);

  // --- Splash Fade Handler ---
  const handleSplashFadeComplete = useCallback(() => {
    setAppIsReady(true);
  }, []);

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
        <GestureHandlerRootView style={{ flex: 1 }}>
          {!appIsReady ? (
            <AppSplashScreen
              startFade={splashState.startFade}
              onFadeComplete={handleSplashFadeComplete}
            />
          ) : (
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
                        <LayoutScrollProvider value={{ scrollY: layoutScrollY }}>
                          <Animated.ScrollView
                            contentContainerStyle={styles.container}
                            style={{ flex: 1 }}
                            onScroll={Animated.event(
                              [{ nativeEvent: { contentOffset: { y: layoutScrollY } } }],
                              { useNativeDriver: false }
                            )}
                            scrollEventThrottle={16}
                          >
                            <SideBar />
                            <View style={styles.mainContent}>
                              <View style={styles.mainContentWrapper}>
                                <Slot />
                              </View>
                              <RightBar />
                            </View>
                          </Animated.ScrollView>
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
          )}
        </GestureHandlerRootView>
      </SafeAreaProvider>
    </View>
  );
}
