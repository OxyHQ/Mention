import { Tabs } from "expo-router";
import { Platform, StyleSheet, useWindowDimensions } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Colors } from "@/constants/Colors";
import { useColorScheme } from "@/hooks/useColorScheme";
import TabBarBackground from "@/components/ui/TabBarBackground";
import { HapticTab } from "@/components/HapticTab";
import { useTranslation } from "react-i18next";

export default function TabLayout() {
  const colorScheme = useColorScheme();
  const { width } = useWindowDimensions();
  const isMobileLayout = width < 768;
  const { t } = useTranslation();

  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: Colors[colorScheme ?? "light"].tint,
        headerShown: false,
        tabBarButton: HapticTab,
        tabBarBackground: TabBarBackground,
        tabBarStyle: isMobileLayout ? styles.tabBar : { display: "none" },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: t("Home"),
          tabBarIcon: ({ color }) => (
            <Ionicons size={28} name="home-outline" color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="search"
        options={{
          title: t("Search"),
          tabBarIcon: ({ color }) => (
            <Ionicons size={28} name="search-outline" color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="notifications"
        options={{
          title: t("Notifications"),
          tabBarIcon: ({ color }) => (
            <Ionicons size={28} name="notifications-outline" color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="messages"
        options={{
          title: t("Messages"),
          tabBarIcon: ({ color }) => (
            <Ionicons size={28} name="mail-outline" color={color} />
          ),
        }}
      />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  tabBar: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    borderTopWidth: 1,
    borderTopColor: "#e1e8ed",
    backgroundColor: Platform.select({
      ios: "transparent",
      default: "#ffffff",
    }),
    elevation: 8,
    shadowColor: "#000",
    shadowOffset: {
      width: 0,
      height: -3,
    },
    shadowOpacity: 0.1,
    shadowRadius: 3,
  },
});
