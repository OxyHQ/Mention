import { useEffect, useRef, useCallback, useState, useContext } from "react";
import { ScrollView, Keyboard, LogBox, Platform } from "react-native";
import * as SplashScreen from 'expo-splash-screen';
import { Provider } from 'react-redux';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { useFonts } from "expo-font";
import { Slot } from 'expo-router';
import store from '@/store/store';
import { useMediaQuery } from 'react-responsive'
import { StatusBar } from "expo-status-bar";
import "react-native-reanimated";
import { SideBar } from '@/components/SideBar';
import { RightBar } from '@/components/RightBar';
import { colors } from '@/styles/colors';
import { useColorScheme } from "@/hooks/useColorScheme";
import { Toaster } from '@/lib/sonner';
import {
  setupNotifications,
  requestNotificationPermissions,
  scheduleDemoNotification,
} from "@/utils/notifications";
import i18n from "i18next";
import { initReactI18next, I18nextProvider, useTranslation } from "react-i18next";
import en from "@/locales/en.json";
import es from "@/locales/es.json";
import it from "@/locales/it.json";
import { View, StyleSheet, } from 'react-native';
import { BottomBar } from "@/components/BottomBar";
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { initialWindowMetrics } from 'react-native-safe-area-context';
import { SessionProvider } from '@/modules/oxyhqservices/components/SessionProvider';
import { MenuProvider } from 'react-native-popup-menu';
import { BottomSheetModal, BottomSheetModalProvider } from "@gorhom/bottom-sheet";
import WebSplashScreen from "@/components/WebSplashScreen";
import LoadingTopSpinner from "@/components/LoadingTopSpinner";
import ErrorBoundary from '@/components/ErrorBoundary';
import { BottomSheetProvider } from '@/context/BottomSheetContext';
import { BottomSheetContext } from '@/context/BottomSheetContext';
import { setBottomSheetContextRef, setAuthBottomSheetFactory } from '@/utils/auth';
import { AuthBottomSheet } from '@/modules/oxyhqservices/components/AuthBottomSheet';
import { AuthModalListener } from '@/modules/oxyhqservices/components/AuthModalListener';
import "../styles/global.css";

// Import React Query
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// Create a client
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000 * 60 * 5, // 5 minutes
      gcTime: 1000 * 60 * 10, // 10 minutes
      retry: 1,
    },
  },
});

// Keep the splash screen visible while we fetch resources
SplashScreen.preventAutoHideAsync();

i18n.use(initReactI18next).init({
  resources: {
    en: { translation: en },
    es: { translation: es },
    it: { translation: it },
  },
  lng: "en",
  fallbackLng: "en",
  interpolation: {
    escapeValue: false,
  },
}).catch(error => {
  console.error("Failed to initialize i18n:", error);
});

export default function RootLayout() {
  const [appIsReady, setAppIsReady] = useState(false);
  const { i18n } = useTranslation();
  const colorScheme = useColorScheme();

  const [loaded] = useFonts({
    "Inter-Black": require("@/assets/fonts/inter/Inter-Black.otf"),
    "Inter-Bold": require("@/assets/fonts/inter/Inter-Bold.otf"),
    "Inter-ExtraBold": require("@/assets/fonts/inter/Inter-ExtraBold.otf"),
    "Inter-ExtraLight": require("@/assets/fonts/inter/Inter-ExtraLight.otf"),
    "Inter-Light": require("@/assets/fonts/inter/Inter-Light.otf"),
    "Inter-Medium": require("@/assets/fonts/inter/Inter-Medium.otf"),
    "Inter-Regular": require("@/assets/fonts/inter/Inter-Regular.otf"),
    "Inter-SemiBold": require("@/assets/fonts/inter/Inter-SemiBold.otf"),
    "Inter-Thin": require("@/assets/fonts/inter/Inter-Thin.otf"),
  });

  const bottomSheetRef = useRef<BottomSheetModal>(null);
  const bottomSheetContext = useContext(BottomSheetContext);

  const handleSheetChanges = useCallback((index: number) => {
    console.log('handleSheetChanges', index);
  }, []);

  const openBottomSheet = () => {
    bottomSheetRef.current?.expand();
  };

  const [keyboardVisible, setKeyboardVisible] = useState(false);

  useEffect(() => {
    const show = Keyboard.addListener("keyboardDidShow", () => setKeyboardVisible(true));
    const hide = Keyboard.addListener("keyboardDidHide", () => setKeyboardVisible(false));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);

  const initializeApp = async () => {
    try {
      if (loaded) {
        await setupNotifications();
        const hasPermission = await requestNotificationPermissions();

        if (hasPermission) {
          await scheduleDemoNotification();
        }
        setAppIsReady(true);
        await SplashScreen.hideAsync();
      }
    } catch (error) {
      console.warn("Failed to set up notifications:", error);
    }
  };

  useEffect(() => {
    initializeApp();

    // Change overflow style to visible only on web
    if (typeof document !== 'undefined') {
      document.body.style.overflow = 'visible';
      document.body.style.backgroundColor = colors.COLOR_BACKGROUND;
    }
  }, [loaded]);

  useEffect(() => {
    if (bottomSheetContext) {
      setBottomSheetContextRef(bottomSheetContext);
      setAuthBottomSheetFactory(() => <AuthBottomSheet />);
    }
  }, [bottomSheetContext]);

  const isScreenNotMobile = useMediaQuery({ minWidth: 500 })

  if (!appIsReady) {
    // check if we are in web
    if (Platform.OS === 'web') {
      return <WebSplashScreen />;
    } else {
      return null;
    }
  }

  const styles = StyleSheet.create({
    container: {
      fontFamily: "Inter-Regular",
      maxWidth: 1300,
      width: '100%',
      paddingHorizontal: isScreenNotMobile ? 10 : 0,
      marginHorizontal: 'auto',
      justifyContent: 'space-between',
      flexDirection: isScreenNotMobile ? 'row' : 'column',
      ...(!isScreenNotMobile && {
        flex: 1,
      }),
    },
    mainContentWrapper: {
      marginVertical: isScreenNotMobile ? 20 : 0,
      flex: isScreenNotMobile ? 2.2 : 1,
      backgroundColor: colors.primaryLight,
      borderRadius: isScreenNotMobile ? 35 : 0,
    },
    contentContainer: {
      flex: 1,
      alignItems: 'center',
    },
  });

  if (!loaded) {
    return null;
  }

  return (
    <SafeAreaProvider initialMetrics={initialWindowMetrics}>
      <GestureHandlerRootView style={{ flex: 1 }}>
        <Provider store={store}>
          <QueryClientProvider client={queryClient}>
            <I18nextProvider i18n={i18n}>
              <SessionProvider>
                <MenuProvider>
                  <ErrorBoundary>
                    <BottomSheetModalProvider>
                      <BottomSheetProvider>
                        <AuthModalListener />
                        <View style={styles.container}>
                          <SideBar />
                          <View style={styles.mainContentWrapper}>
                            <LoadingTopSpinner showLoading={false} size={20} style={{ paddingBottom: 0, }} />
                            <Slot />
                          </View>
                          <RightBar />
                        </View>
                        <StatusBar style="auto" />
                        <Toaster position="bottom-center" swipeToDismissDirection="left" offset={15} />
                        {!isScreenNotMobile && !keyboardVisible && <BottomBar />}
                      </BottomSheetProvider>
                    </BottomSheetModalProvider>
                  </ErrorBoundary>
                </MenuProvider>
              </SessionProvider>
            </I18nextProvider>
          </QueryClientProvider>
        </Provider>
      </GestureHandlerRootView>
    </SafeAreaProvider>
  );
}
