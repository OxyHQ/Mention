import { useEffect } from "react";
import {
  DarkTheme,
  DefaultTheme,
  ThemeProvider,
} from "@react-navigation/native";
import { useFonts } from "expo-font";
import { Stack } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import "react-native-reanimated";
import { ResponsiveLayout } from "@/components/ResponsiveLayout";
import { Sidebar } from "@/components/Sidebar";
import { Widgets } from "@/components/Widgets";
import { useColorScheme } from "@/hooks/useColorScheme";
import {
  setupNotifications,
  requestNotificationPermissions,
  scheduleDemoNotification,
} from "@/utils/notifications";

// Prevent the splash screen from auto-hiding before asset loading is complete.
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
          await SplashScreen.hideAsync();
          await setupNotifications();
          const hasPermission = await requestNotificationPermissions();

          if (hasPermission) {
            await scheduleDemoNotification();
          }
        }
      } catch (error) {
        console.warn("Failed to set up notifications:", error);
      }
    }

    initializeApp();
  }, [loaded]);

  if (!loaded) {
    return null;
  }

  return (
    <ThemeProvider value={colorScheme === "dark" ? DarkTheme : DefaultTheme}>
      <ResponsiveLayout
        sidebarContent={<Sidebar />}
        widgetsContent={<Widgets />}
        mainContent={
          <Stack>
            <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
            <Stack.Screen name="+not-found" />
          </Stack>
        }
      />
      <StatusBar style="auto" />
    </ThemeProvider>
  );
}
