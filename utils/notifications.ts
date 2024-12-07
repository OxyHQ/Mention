import * as Notifications from "expo-notifications";
import { Platform } from "react-native";

export async function requestNotificationPermissions() {
  if (Platform.OS === "web") {
    return false;
  }
  const { status } = await Notifications.requestPermissionsAsync();
  return status === "granted";
}

export async function scheduleDemoNotification() {
  if (Platform.OS === "web") {
    return;
  }
  await Notifications.scheduleNotificationAsync({
    content: {
      title: "Welcome to Mention! 👋",
      body: "Thanks for trying out our app. Start exploring now!",
      data: { screen: "notifications" },
    },
    trigger: null, // Shows notification immediately
  });
}

export async function createNotification(
  title: string,
  body: string,
  data: object = {}
) {
  if (Platform.OS === "web") {
    return;
  }
  await Notifications.scheduleNotificationAsync({
    content: {
      title,
      body,
      data,
    },
    trigger: null, // Shows notification immediately
  });
}

export async function setupNotifications() {
  if (Platform.OS === "web") {
    return;
  }
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowAlert: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
    }),
  });
}
