import { useEffect } from "react";
import { DarkTheme, DefaultTheme, ThemeProvider } from "@react-navigation/native";
import { useFonts } from "expo-font";
import { Slot } from 'expo-router';
import * as SplashScreen from "expo-splash-screen";
import { useMediaQuery } from 'react-responsive'
import { StatusBar } from "expo-status-bar";
import "react-native-reanimated";
import { SideBar } from '@/components/SideBar';
import { RightBar } from '@/components/RightBar';
import { colors } from '@/styles/colors';
import { useColorScheme } from "@/hooks/useColorScheme";
import {
  setupNotifications,
  requestNotificationPermissions,
  scheduleDemoNotification,
} from "@/utils/notifications";
import { Dimensions, Platform, Text, View, ViewStyle, StyleSheet, useWindowDimensions, } from 'react-native';

SplashScreen.preventAutoHideAsync();


export default function RootLayout() {
  const colorScheme = useColorScheme();

  const [loaded] = useFonts({
    SpaceMono: require("../assets/fonts/SpaceMono-Regular.ttf"),
  });

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

  const isScreenRoundedEnabled = useMediaQuery({ minWidth: 500 })

  const styles = StyleSheet.create({
    container: {
      maxWidth: 1600,
      width: '100%',
      marginHorizontal: 'auto',
      justifyContent: 'space-between',
      flexDirection: 'row',
      ...Platform.select({
        android: {
          flex: 1,
        },
      }),
    },
    mainContentWrapper: {
      marginVertical: isScreenRoundedEnabled ? 20 : 0,
      flex: 2.2,
      backgroundColor: colors.primaryLight,
      borderRadius: isScreenRoundedEnabled ? 35 : 0,
    },
  });

  if (!loaded) {
    return null;
  }

  return (
    <View style={styles.container}>
      <SideBar />
      <View style={styles.mainContentWrapper}>
        <Slot />
      </View>
      <RightBar />
      <StatusBar style="auto" />
    </View>
  );
}
