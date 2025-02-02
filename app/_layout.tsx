import { useEffect, useRef, useCallback, useState } from "react";
import { ScrollView, Keyboard } from "react-native";
import { Provider } from 'react-redux';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { DarkTheme, DefaultTheme, ThemeProvider } from "@react-navigation/native";
import { useFonts } from "expo-font";
import { Slot } from 'expo-router';
import store from '@/store/store';
import * as SplashScreen from "expo-splash-screen";
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
import { Dimensions, Platform, Text, View, ViewStyle, StyleSheet, useWindowDimensions, } from 'react-native';
import { BottomBar } from "@/components/BottomBar";
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { initialWindowMetrics } from 'react-native-safe-area-context';
import { BottomSheetProvider } from '@/context/BottomSheetContext';
import { SessionOwnerButton } from '@/modules/oxyhqservices/components/SessionOwnerButton';
import { SessionProvider } from '@/modules/oxyhqservices/components/SessionProvider';
import { MenuProvider } from 'react-native-popup-menu';
import { BottomSheetModal } from "@gorhom/bottom-sheet";

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

  useEffect(() => {
    async function initializeApp() {
      try {
        if (loaded) {
          await setupNotifications();
          const hasPermission = await requestNotificationPermissions();

          if (hasPermission) {
            await scheduleDemoNotification();
          }
          await SplashScreen.hideAsync();
        }
      } catch (error) {
        console.warn("Failed to set up notifications:", error);
      }
    }

    initializeApp();

    // Change overflow style to visible only on web
    if (typeof document !== 'undefined') {
      document.body.style.overflow = 'visible';
      document.body.style.backgroundColor = colors.COLOR_BACKGROUND;
    }
  }, [loaded]);

  const isScreenNotMobile = useMediaQuery({ minWidth: 500 })

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
      <GestureHandlerRootView>
        <Provider store={store}>
          <I18nextProvider i18n={i18n}>
            <BottomSheetProvider>
              <SessionProvider>
                <MenuProvider>
                  <View style={{ flex: 1 }}>
                    <View style={styles.container}>
                      <SideBar />
                      <View style={styles.mainContentWrapper}>
                        <Slot />
                      </View>
                      <RightBar />
                    </View>
                  </View>
                  <StatusBar style="auto" />
                  <Toaster position="bottom-center" swipeToDismissDirection="left" offset={15} />
                  {!isScreenNotMobile && !keyboardVisible && <BottomBar />}
                </MenuProvider>
              </SessionProvider>
            </BottomSheetProvider>
          </I18nextProvider>
        </Provider>
      </GestureHandlerRootView>
    </SafeAreaProvider>
  );
}
