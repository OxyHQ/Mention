import React, { useState, useEffect } from "react";
import { View, FlatList, StyleSheet, ActivityIndicator, Pressable, RefreshControl } from "react-native";
import { ThemedView } from "@/components/ThemedView";
import { ThemedText } from "@/components/ThemedText";
import { useTranslation } from "react-i18next";
import { Header } from "@/components/Header";
import { fetchData } from "@/utils/api";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { initializeNotificationSocket, getNotificationSocket } from "@/utils/notificationsSocket";
import { router } from "expo-router";
import Avatar from "@/components/Avatar";
import { getData } from "@/utils/storage";
import { format } from "date-fns";

type Notification = {
  id: string;
  type: string;
  actorId: {
    _id: string;
    username: string;
    name: string;
    avatar: string;
  };
  entityId: any;
  read: boolean;
  createdAt: string;
};

const NotificationItem = ({ notification, onNotificationPress }: { notification: Notification, onNotificationPress: (notification: Notification) => void }) => (
  <Pressable 
    style={[styles.notificationContainer, !notification.read && styles.unreadNotification]}
    onPress={() => onNotificationPress(notification)}
  >
    <Avatar id={notification.actorId._id} size={50} />
    <View style={styles.notificationContent}>
      <ThemedText style={styles.notificationText}>
        <ThemedText style={styles.userName}>
          {notification.actorId.name}
        </ThemedText>{" "}
        {getNotificationContent(notification)}
      </ThemedText>
      <ThemedText style={styles.timestamp}>
        {format(new Date(notification.createdAt), 'PPp')}
      </ThemedText>
    </View>
    {getNotificationIcon(notification.type)}
  </Pressable>
);

const getNotificationContent = (notification: Notification) => {
  switch (notification.type) {
    case 'like':
      return 'liked your post';
    case 'reply':
      return 'replied to your post';
    case 'mention':
      return 'mentioned you in a post';
    case 'follow':
      return 'started following you';
    case 'repost':
      return 'reposted your post';
    case 'quote':
      return 'quoted your post';
    default:
      return 'interacted with your content';
  }
};

const getNotificationIcon = (type: string) => {
  switch (type) {
    case 'like':
      return <Ionicons name="heart" size={20} color="#E0245E" style={styles.icon} />;
    case 'reply':
      return <Ionicons name="chatbubble" size={20} color="#17BF63" style={styles.icon} />;
    case 'mention':
      return <Ionicons name="at" size={20} color="#1DA1F2" style={styles.icon} />;
    case 'follow':
      return <Ionicons name="person-add" size={20} color="#794BC4" style={styles.icon} />;
    case 'repost':
      return <Ionicons name="repeat" size={20} color="#17BF63" style={styles.icon} />;
    case 'quote':
      return <Ionicons name="chatbubbles" size={20} color="#1DA1F2" style={styles.icon} />;
    default:
      return null;
  }
};

export default function NotificationsScreen() {
  const { t } = useTranslation();
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const fetchNotifications = async () => {
    try {
      const response = await fetchData("notifications");
      setNotifications(response.notifications);
    } catch (error) {
      console.error("Error fetching notifications:", error);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  const handleNotificationPress = async (notification: Notification) => {
    // Mark as read
    const socket = getNotificationSocket();
    socket?.emit('markNotificationRead', { notificationId: notification.id });

    // Navigate based on notification type
    switch (notification.type) {
      case 'like':
      case 'reply':
      case 'quote':
      case 'repost':
        router.push(`/post/${notification.entityId}`);
        break;
      case 'follow':
        router.push(`/${notification.actorId.username}`);
        break;
      case 'mention':
        router.push(`/post/${notification.entityId}`);
        break;
    }
  };

  const setupSocketListeners = async () => {
    const socket = await initializeNotificationSocket();
    if (!socket) return;

    socket.on('notification', (newNotification: Notification) => {
      setNotifications(prev => [newNotification, ...prev]);
    });

    socket.on('notificationUpdated', (updatedNotification: Notification) => {
      setNotifications(prev =>
        prev.map(notif =>
          notif.id === updatedNotification.id ? updatedNotification : notif
        )
      );
    });

    socket.on('allNotificationsRead', () => {
      setNotifications(prev =>
        prev.map(notif => ({ ...notif, read: true }))
      );
    });

    // Join user's notification room
    const userId = await getData('userId');
    if (userId) {
      socket.emit('joinRoom', `user:${userId}`);
    }
  };

  useEffect(() => {
    fetchNotifications();
    setupSocketListeners();
  }, []);

  const onRefresh = React.useCallback(() => {
    setRefreshing(true);
    fetchNotifications();
  }, []);

  const markAllAsRead = () => {
    const socket = getNotificationSocket();
    socket?.emit('markAllNotificationsRead');
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      <Header 
        options={{ 
          title: t("Notifications"),
          rightComponents: [
            <Pressable key="markAllRead" onPress={markAllAsRead} style={styles.markAllRead}>
              <ThemedText>Mark all as read</ThemedText>
            </Pressable>
          ]
        }} 
      />
      <View style={styles.container}>
        {loading ? (
          <ActivityIndicator size="large" color="#1DA1F2" />
        ) : (
          <FlatList
            data={notifications}
            renderItem={({ item }) => (
              <NotificationItem 
                notification={item} 
                onNotificationPress={handleNotificationPress}
              />
            )}
            keyExtractor={(item) => item.id}
            refreshControl={
              <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
            }
          />
        )}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
  },
  container: {
    flex: 1,
  },
  notificationContainer: {
    flexDirection: "row",
    padding: 15,
    borderBottomWidth: 1,
    borderBottomColor: "#e1e8ed",
    alignItems: "center",
  },
  unreadNotification: {
    backgroundColor: "#f0f8ff",
  },
  notificationContent: {
    flex: 1,
    marginHorizontal: 10,
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
    fontSize: 12,
  },
  icon: {
    marginLeft: 10,
  },
  markAllRead: {
    padding: 8,
  },
});
