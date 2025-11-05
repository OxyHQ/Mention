// Import Reanimated early to ensure proper initialization before other modules
import 'react-native-reanimated';

import { OxyProvider, OxyServices } from '@oxyhq/services';
import NetInfo from '@react-native-community/netinfo';
import { QueryClient, QueryClientProvider, focusManager, onlineManager } from '@tanstack/react-query';
import { useFonts } from "expo-font";
import { Slot } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import i18n, { init as i18nInit, use as i18nUse } from "i18next";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { AppState, Platform, StyleSheet, View, type AppStateStatus } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { MenuProvider } from "react-native-popup-menu";
import { SafeAreaProvider, initialWindowMetrics } from "react-native-safe-area-context";

// Components
import AppSplashScreen from '@/components/AppSplashScreen';
import { BottomBar } from "@/components/BottomBar";
import ErrorBoundary from '@/components/ErrorBoundary';
import { NotificationPermissionSheet } from '@/components/NotificationPermissionSheet';
import RegisterPush from '@/components/RegisterPushToken';
import { RightBar } from "@/components/RightBar";
import { SideBar } from "@/components/SideBar";
import { ThemedView } from "@/components/ThemedView";

// Hooks
import { useColorScheme } from "@/hooks/useColorScheme";
import { useKeyboardVisibility } from "@/hooks/useKeyboardVisibility";
import { useIsScreenNotMobile } from "@/hooks/useOptimizedMediaQuery";
import useRealtimePosts from '@/hooks/useRealtimePosts';
import { useTheme } from '@/hooks/useTheme';

// Context
import { BottomSheetContext, BottomSheetProvider } from '@/context/BottomSheetContext';
import { HomeRefreshProvider } from '@/context/HomeRefreshContext';
import { LayoutScrollProvider, useLayoutScroll } from '@/context/LayoutScrollContext';

// Utils & Config
import { oxyServices } from '@/lib/oxyServices';
import { Toaster } from "@/lib/sonner";
import { useAppearanceStore } from '@/store/appearanceStore';
import { useVideoMuteStore } from '@/stores/videoMuteStore';
import {
  hasNotificationPermission,
  requestNotificationPermissions,
  setupNotifications,
} from "@/utils/notifications";

// Locales
import enUS from "@/locales/en.json";
import esES from "@/locales/es.json";
import itIT from "@/locales/it.json";

// Styles
import '../styles/global.css';

// Types
interface SplashState {
  initializationComplete: boolean;
  startFade: boolean;
}

// Constants
const QUERY_CLIENT_CONFIG = {
  defaultOptions: {
    queries: {
      retry: 2,
      staleTime: 1000 * 30,
      gcTime: 1000 * 60 * 10,
      refetchOnReconnect: true,
      refetchOnWindowFocus: true,
    },
  },
} as const;

const I18N_CONFIG = {
  resources: {
    'en-US': { translation: enUS },
    'es-ES': { translation: esES },
    'it-IT': { translation: itIT },
  },
  lng: 'en-US',
  fallbackLng: 'en-US',
  interpolation: { escapeValue: false },
} as const;

interface MainLayoutProps {
  isScreenNotMobile: boolean;
}

const MainLayout: React.FC<MainLayoutProps> = ({ isScreenNotMobile }) => {
  const theme = useTheme();
  const { forwardWheelEvent } = useLayoutScroll();

  const styles = useMemo(() => StyleSheet.create({
    container: {
      flex: 1,
      width: '100%',
      marginHorizontal: 'auto',
      flexDirection: isScreenNotMobile ? 'row' : 'column',
      backgroundColor: theme.colors.background,
    },
    mainContent: {
      maxWidth: 1100,
      marginHorizontal: isScreenNotMobile ? 'auto' : 0,
      justifyContent: 'space-between',
      flexDirection: isScreenNotMobile ? 'row' : 'column',
      flex: 1,
      backgroundColor: theme.colors.background,
    },
    mainContentWrapper: {
      flex: isScreenNotMobile ? 2.2 : 1,
      ...(isScreenNotMobile ? {
        borderLeftWidth: 0.5,
        borderRightWidth: 0.5,
        borderColor: theme.colors.border,
      } : {}),
      backgroundColor: theme.colors.background,
    },
  }), [isScreenNotMobile, theme.colors]);

  const handleWheel = useCallback((event: any) => {
    forwardWheelEvent(event);
  }, [forwardWheelEvent]);

  const containerProps = Platform.OS === 'web' ? { onWheel: handleWheel } : {};

  return (
    <View style={styles.container} {...containerProps}>
      <SideBar />
      <View style={styles.mainContent}>
        <ThemedView style={styles.mainContentWrapper}>
          <Slot />
        </ThemedView>
        <RightBar />
      </View>
    </View>
  );
};

export default function RootLayout() {
  // State
  const [appIsReady, setAppIsReady] = useState(false);
  const [splashState, setSplashState] = useState<SplashState>({
    initializationComplete: false,
    startFade: false,
  });

  // Hooks
  const isScreenNotMobile = useIsScreenNotMobile();
  const colorScheme = useColorScheme();
  const keyboardVisible = useKeyboardVisibility();

  // Memoized instances
  const queryClient = useMemo(() => new QueryClient(QUERY_CLIENT_CONFIG), []);
  // oxyServices is now imported from shared instance

  // Font Loading
  const [fontsLoaded] = useFonts({
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

  // Callbacks
  const handleSplashFadeComplete = useCallback(() => {
    setAppIsReady(true);
  }, []);

  const waitForAuth = useCallback(async (services: OxyServices, timeoutMs = 5000): Promise<boolean> => {
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
    if (!fontsLoaded) return;

    try {
      // Setup notifications for native platforms
      if (Platform.OS !== 'web') {
        await setupNotifications();
        await hasNotificationPermission();
      }

      // Wait for auth to be ready
      const authReady = await waitForAuth(oxyServices, 5000);

      if (authReady) {
        try {
          await oxyServices.getCurrentUser();
        } catch (err) {
          console.warn('Failed to fetch current user during init:', err);
        }
      }

      // Load appearance settings (uses cache for instant theme)
      try {
        await useAppearanceStore.getState().loadMySettings();
      } catch (err) {
        console.warn('Failed to load appearance settings during init:', err);
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
  }, [fontsLoaded, oxyServices, waitForAuth]);


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

  // Alias GestureHandlerRootView to a permissive component type to avoid children typing issues
  const GestureRoot = GestureHandlerRootView as unknown as React.ComponentType<any>;

  // Effects
  // Load appearance settings eagerly on mount (uses cache for instant theme)
  useEffect(() => {
    useAppearanceStore.getState().loadMySettings().catch(err => {
      console.warn('Early appearance settings load failed:', err);
    });
  }, []);

  // Load video mute state eagerly on mount
  useEffect(() => {
    useVideoMuteStore.getState().loadMutedState().catch(err => {
      console.warn('Failed to load video mute state:', err);
    });
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

  // Inline component that lives under BottomSheetProvider context
  const NotificationPermissionGate: React.FC = () => {
    const bs = React.useContext(BottomSheetContext);
    useEffect(() => {
      let didCancel = false;
      const run = async () => {
        if (Platform.OS === 'web') return;
        if (!appIsReady || !splashState.initializationComplete) return;
        const hasPerm = await hasNotificationPermission();
        if (didCancel || hasPerm) return;
        bs.setBottomSheetContent(
          <NotificationPermissionSheet
            onLater={() => bs.openBottomSheet(false)}
            onEnable={async () => {
              const granted = await requestNotificationPermissions();
              bs.openBottomSheet(false);
              if (granted) {
                // token registration handled by <RegisterPush />
              }
            }}
          />
        );
        bs.openBottomSheet(true);
      };
      const t = setTimeout(run, 400);
      return () => {
        didCancel = true;
        clearTimeout(t);
      };
    }, [bs]);
    return null;
  };

  useEffect(() => {
    if (fontsLoaded && splashState.initializationComplete && !splashState.startFade) {
      setSplashState((prev) => ({ ...prev, startFade: true }));
    }
  }, [fontsLoaded, splashState.initializationComplete, splashState.startFade]);

  // Main layout component for better organization
  // Inline bridge component rendered under OxyProvider to safely access useOxy
  const RealtimePostsBridge: React.FC = () => {
    useRealtimePosts();
    return null;
  };

  const theme = useTheme();
  
  return (
    <ThemedView style={{ flex: 1 }}>
      <SafeAreaProvider initialMetrics={initialWindowMetrics}>
        <View style={{ flex: 1, backgroundColor: theme.colors.background }}>
          <GestureRoot style={{ flex: 1, backgroundColor: theme.colors.background }}>
          {appIsReady ? (
            <QueryClientProvider client={queryClient}>
              <OxyProvider
                oxyServices={oxyServices}
                initialScreen="SignIn"
                autoPresent={false}
                storageKeyPrefix="oxy_example"
                theme={colorScheme}
              >
                <I18nextProvider i18n={i18n}>
                  <BottomSheetProvider>
                    <MenuProvider>
                      <ErrorBoundary>
                        <LayoutScrollProvider>
                          <HomeRefreshProvider>
                            {/* Shows bottom sheet permission prompt when needed (native only) */}
                            {Platform.OS !== 'web' && <NotificationPermissionGate />}
                            {/* Keep posts socket connected (mounted under OxyProvider) */}
                            <RealtimePostsBridge />
                            <MainLayout isScreenNotMobile={isScreenNotMobile} />
                            <StatusBar style="auto" />
                            <RegisterPush />
                            <Toaster
                              position="bottom-center"
                              swipeToDismissDirection="left"
                              offset={15}
                            />
                            {!isScreenNotMobile && !keyboardVisible && <BottomBar />}
                          </HomeRefreshProvider>
                        </LayoutScrollProvider>
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
        </View>
      </SafeAreaProvider>
    </ThemedView>
  );
}
