import React, { useState, useEffect, useRef } from "react";
import { View, FlatList, ActivityIndicator, Pressable, RefreshControl } from "react-native";
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
import Post from "@/components/Post";

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

const NotificationItem = ({ notification, onNotificationPress }: { notification: Notification, onNotificationPress: (notification: Notification) => void }) => {
  const [postData, setPostData] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const fetchPostData = async () => {
      if (['like', 'reply', 'quote', 'repost', 'mention'].includes(notification.type) && notification.entityId) {
        setLoading(true);
        try {
          const response = await fetchData(`posts/${notification.entityId}`);
          if (response?.posts?.[0]) {
            setPostData(response.posts[0]);
          }
        } catch (error) {
          console.error('Error fetching post:', error);
        } finally {
          setLoading(false);
        }
      }
    };

    fetchPostData();
  }, [notification]);

  return (
    <Pressable 
      className={`flex-column p-4 border-b border-gray-200 ${!notification.read ? 'bg-blue-50' : ''}`}
      onPress={() => onNotificationPress(notification)}
    >
      <View className="flex-row items-center">
        <Avatar id={notification.actorId.avatar} size={50} />
        <View className="flex-1 mx-2.5">
          <ThemedText className="text-base">
            {getNotificationContent(notification)}
          </ThemedText>
          <ThemedText className="text-gray-500 mt-1.5 text-xs">
            {format(new Date(notification.createdAt), 'PPp')}
          </ThemedText>
        </View>
        {getNotificationIcon(notification.type)}
      </View>
      {loading ? (
        <ActivityIndicator size="small" className="ml-[50px] mt-2" />
      ) : (
        postData && ['like', 'reply', 'quote', 'repost', 'mention'].includes(notification.type) && (
          <Post postData={postData} className="rounded-xl ml-[50px] mt-2 border border-gray-200" showActions={false} />
        )
      )}
    </Pressable>
  );
};

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
    case 'welcome':
      const name = notification.actorId.name?.first && notification.actorId.name?.last 
        ? `${notification.actorId.name.first} ${notification.actorId.name.last}` 
        : notification.actorId.username;
      return (
        <>
          Hey <ThemedText style={{ fontWeight: 'bold' }}>{name}</ThemedText>! Welcome to Mention. We're excited to have you here and hope you enjoy using the app. Feel free to explore, and let us know your thoughts—we'd love to hear your feedback!
        </>
      );
    default:
      return 'interacted with your content';
  }
};

const getNotificationIcon = (type: string) => {
  switch (type) {
    case 'like':
      return <Ionicons name="heart" size={20} color="#E0245E" className="ml-2.5" />;
    case 'reply':
      return <Ionicons name="chatbubble" size={20} color="#17BF63" className="ml-2.5" />;
    case 'mention':
      return <Ionicons name="at" size={20} color="#1DA1F2" className="ml-2.5" />;
    case 'follow':
      return <Ionicons name="person-add" size={20} color="#794BC4" className="ml-2.5" />;
    case 'repost':
      return <Ionicons name="repeat" size={20} color="#17BF63" className="ml-2.5" />;
    case 'quote':
      return <Ionicons name="chatbubbles" size={20} color="#1DA1F2" className="ml-2.5" />;
    case 'welcome':
      return <Ionicons name="notifications" size={20} color="#1DA1F2" className="ml-2.5" />;
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
    <SafeAreaView className="flex-1">
      <Header 
        options={{ 
          title: t("Notifications"),
          rightComponents: notifications.length > 0 ? [
            <Pressable key="markAllRead" onPress={markAllAsRead} className="p-2">
              <ThemedText>Mark all as read</ThemedText>
            </Pressable>
          ] : undefined
        }} 
      />
      {socketStatus !== 'Connected' && (
        <View className="p-2 bg-red-50 items-center">
          <ThemedText className="text-red-800 text-xs">
            {socketStatus || 'Connecting...'}
          </ThemedText>
        </View>
      )}
      <View className="flex-1">
        {loading && page === 1 ? (
          <ActivityIndicator size="large" color="#1DA1F2" />
        ) : error ? (
          <View className="flex-1 items-center justify-center p-5">
            <ThemedText className="text-base text-center mb-4">{error}</ThemedText>
            <Pressable onPress={() => fetchNotifications(1, true)} className="bg-[#1DA1F2] px-5 py-2.5 rounded-full">
              <ThemedText className="text-white text-base">{t("Try Again")}</ThemedText>
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
              <View className="flex-1 items-center justify-center p-5">
                <ThemedText className="text-base text-gray-500">
                  {t("No notifications yet")}
                </ThemedText>
              </View>
            }
            ListFooterComponent={
              loading && page > 1 ? (
                <ActivityIndicator size="small" color="#1DA1F2" className="py-5" />
              ) : null
            }
          />
        )}
      </View>
    </SafeAreaView>
  );
}
