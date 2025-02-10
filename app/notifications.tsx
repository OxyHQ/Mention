import React, { useState, useEffect, useRef } from "react";
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
import { Socket } from 'socket.io-client';

type Notification = {
  id: string;
  type: string;
  actorId: {
    _id: string;
    username: string;
    name: {
      first: string,
      last: string
    };
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
    <Avatar id={notification.actorId.avatar} size={50} />
    <View style={styles.notificationContent}>
      <ThemedText style={styles.notificationText}>
        <ThemedText style={styles.userName}>
          {notification.actorId.name?.first} {notification.actorId.name?.last}
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
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(true);
  const [socketStatus, setSocketStatus] = useState<string>('Initializing...');
  const socketRef = useRef<Socket | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const initializingRef = useRef(false);

  const initializeSocket = async () => {
    if (initializingRef.current) return;
    initializingRef.current = true;

    try {
      setSocketStatus('Connecting...');
      const socket = await initializeNotificationSocket();
      
      if (!socket) {
        setSocketStatus('Connection failed');
        setError('Failed to initialize notification socket');
        return;
      }

      socketRef.current = socket;
      const id = await getData('userId');
      if (id && typeof id === 'string') {
        setUserId(id);
        socket.emit('joinRoom', `user:${id}`);
      }

      socket.on('connect', () => {
        console.log('Socket connected successfully');
        setSocketStatus('Connected');
        setError(null);
      });

      socket.on('connect_error', (error) => {
        console.error('Socket connection error:', error);
        setSocketStatus(`Connection error: ${error.message}`);
      });

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
    } catch (err) {
      console.error('Error in initializeSocket:', err);
      setSocketStatus(`Setup error: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      initializingRef.current = false;
    }
  };

  useEffect(() => {
    initializeSocket();

    return () => {
      if (socketRef.current) {
        socketRef.current.off('connect');
        socketRef.current.off('connect_error');
        socketRef.current.off('notification');
        socketRef.current.off('notificationUpdated');
        socketRef.current.off('allNotificationsRead');
        socketRef.current.disconnect();
      }
    };
  }, []);

  const fetchNotifications = async (pageNum = 1, shouldRefresh = false) => {
    try {
      setError(null);
      const response = await fetchData(`notifications?page=${pageNum}&limit=20`);
      
      if (!response.notifications) {
        throw new Error(response.message || 'No notifications data');
      }

      setNotifications(prev => 
        shouldRefresh ? response.notifications : [...prev, ...response.notifications]
      );
      setHasMore(response.hasMore);
      setPage(response.page);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Error fetching notifications';
      console.error("Error fetching notifications:", error);
      setError(errorMessage);
      if (shouldRefresh) {
        setNotifications([]);
      }
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    if (userId) {
      fetchNotifications(1, true);
    }
  }, [userId]);

  const handleNotificationPress = async (notification: Notification) => {
    // Mark as read
    const socket = getNotificationSocket();
    socket?.emit('markNotificationRead', { notificationId: notification.id });

    // Navigate based on notification type
    switch (notification.type) {
      case 'like':
        router.push(`/post/${notification.entityId}`);
        break;
      case 'reply':
        router.push(`/post/${notification.entityId}`);
        break;
      case 'quote':
        router.push(`/post/${notification.entityId}`);
        break;
      case 'repost':
        router.push(`/post/${notification.entityId}`);
        break;
      case 'follow':
        router.push(`/@${notification.actorId.username}`);
        break;
      case 'mention':
        router.push(`/post/${notification.entityId}`);
        break;
    }
  };

  const onRefresh = React.useCallback(() => {
    setRefreshing(true);
    fetchNotifications(1, true);
  }, []);

  const markAllAsRead = () => {
    const socket = getNotificationSocket();
    socket?.emit('markAllNotificationsRead');
  };

  const handleLoadMore = () => {
    if (!loading && hasMore) {
      fetchNotifications(page + 1, false);
    }
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      <Header 
        options={{ 
          title: t("Notifications"),
          rightComponents: notifications.length > 0 ? [
            <Pressable key="markAllRead" onPress={markAllAsRead} style={styles.markAllRead}>
              <ThemedText>Mark all as read</ThemedText>
            </Pressable>
          ] : undefined
        }} 
      />
      {socketStatus !== 'Connected' && (
        <View style={styles.socketStatusContainer}>
          <ThemedText style={styles.socketStatusText}>
            {socketStatus || 'Connecting...'}
          </ThemedText>
        </View>
      )}
      <View style={styles.container}>
        {loading && page === 1 ? (
          <ActivityIndicator size="large" color="#1DA1F2" />
        ) : error ? (
          <View style={styles.errorContainer}>
            <ThemedText style={styles.errorText}>{error}</ThemedText>
            <Pressable onPress={() => fetchNotifications(1, true)} style={styles.retryButton}>
              <ThemedText style={styles.retryText}>{t("Try Again")}</ThemedText>
            </Pressable>
          </View>
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
              <RefreshControl 
                refreshing={refreshing} 
                onRefresh={() => {
                  setRefreshing(true);
                  fetchNotifications(1, true);
                }}
              />
            }
            onEndReached={handleLoadMore}
            onEndReachedThreshold={0.5}
            ListEmptyComponent={
              <View style={styles.emptyContainer}>
                <ThemedText style={styles.emptyText}>
                  {t("No notifications yet")}
                </ThemedText>
              </View>
            }
            ListFooterComponent={
              loading && page > 1 ? (
                <ActivityIndicator size="small" color="#1DA1F2" style={styles.loadingFooter} />
              ) : null
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
  errorContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 20,
  },
  errorText: {
    fontSize: 16,
    textAlign: 'center',
    marginBottom: 16,
  },
  retryButton: {
    backgroundColor: '#1DA1F2',
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 20,
  },
  retryText: {
    color: '#FFFFFF',
    fontSize: 16,
  },
  emptyContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 20,
  },
  emptyText: {
    fontSize: 16,
    color: 'gray',
  },
  loadingFooter: {
    paddingVertical: 20,
  },
  socketStatusContainer: {
    padding: 8,
    backgroundColor: '#ffebee',
    alignItems: 'center',
  },
  socketStatusText: {
    color: '#c62828',
    fontSize: 12,
  },
});
