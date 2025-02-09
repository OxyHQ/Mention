import React, { useState, useEffect } from "react";
import { Stack, router } from "expo-router";
import { View, Text, FlatList, StyleSheet, Image, ActivityIndicator } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { ThemedView } from "@/components/ThemedView";
import { ThemedText } from "@/components/ThemedText";
import { useTranslation } from "react-i18next";
import { Header } from "@/components/Header";
import { fetchData } from "@/utils/api";
import { SafeAreaView } from "react-native-safe-area-context";

type Notification = {
  id: string;
  type: string;
  user: {
    name: string;
    avatar: string;
  };
  content: string;
  timestamp: string;
  read: boolean;
};

const NotificationItem = ({ notification }: { notification: Notification }) => (
  <View style={[styles.notificationContainer, !notification.read && styles.unreadNotification]}>
    <Image source={{ uri: notification.user.avatar }} style={styles.avatar} />
    <View style={styles.notificationContent}>
      <ThemedText style={styles.notificationText}>
        <ThemedText style={styles.userName}>
          {notification.user.name}
        </ThemedText>{" "}
        {notification.content}
      </ThemedText>
      <ThemedText style={styles.timestamp}>{notification.timestamp}</ThemedText>
    </View>
    {notification.type === "like" && (
      <Ionicons name="heart" size={20} color="#E0245E" style={styles.icon} />
    )}
    {notification.type === "repost" && (
      <Ionicons name="repeat" size={20} color="#17BF63" style={styles.icon} />
    )}
  </View>
);

export default function NotificationsScreen() {
  const { t } = useTranslation();
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchNotifications = async () => {
    try {
      const response = await fetchData("notifications");
      setNotifications(response.notifications);
    } catch (error) {
      console.error("Error fetching notifications:", error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchNotifications();
  }, []);

  const unreadCount = notifications.filter((notification) => !notification.read).length;

  return (
    <SafeAreaView>
      <Header options={{ title: `${t("Notifications")} (${unreadCount})` }} />
      <View style={styles.container}>
        {loading ? (
          <ActivityIndicator size="large" color="#1DA1F2" />
        ) : (
          <FlatList
            data={notifications}
            renderItem={({ item }) => <NotificationItem notification={item} />}
            keyExtractor={(item) => item.id}
          />
        )}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
  },
  notificationContainer: {
    flexDirection: "row",
    padding: 15,
    borderBottomWidth: 1,
    borderBottomColor: "#e1e8ed",
  },
  unreadNotification: {
    backgroundColor: "#f0f8ff",
  },
  avatar: {
    width: 50,
    height: 50,
    borderRadius: 25,
    marginRight: 10,
  },
  notificationContent: {
    flex: 1,
  },
  notificationText: {
    fontSize: 16,
  },
  userName: {
    fontWeight: "bold",
  },
  timestamp: {
    color: "gray",
    marginTop: 5,
  },
  icon: {
    marginLeft: 10,
  },
});
