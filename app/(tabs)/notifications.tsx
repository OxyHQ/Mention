import React from "react";
import { View, Text, FlatList, StyleSheet, Image } from "react-native";
import { Ionicons } from "@expo/vector-icons";

const notifications = [
  {
    id: "1",
    type: "like",
    user: {
      name: "Jane Smith",
      avatar: "https://via.placeholder.com/50",
    },
    content: "liked your Tweet",
    timestamp: "2h ago",
  },
  {
    id: "2",
    type: "retweet",
    user: {
      name: "Bob Johnson",
      avatar: "https://via.placeholder.com/50",
    },
    content: "retweeted your Tweet",
    timestamp: "4h ago",
  },
  // Add more notifications
];

type Notification = {
  id: string;
  type: string;
  user: {
    name: string;
    avatar: string;
  };
  content: string;
  timestamp: string;
};

const NotificationItem = ({ notification }: { notification: Notification }) => (
  <View style={styles.notificationContainer}>
    <Image source={{ uri: notification.user.avatar }} style={styles.avatar} />
    <View style={styles.notificationContent}>
      <Text style={styles.notificationText}>
        <Text style={styles.userName}>{notification.user.name}</Text>{" "}
        {notification.content}
      </Text>
      <Text style={styles.timestamp}>{notification.timestamp}</Text>
    </View>
    {notification.type === "like" && (
      <Ionicons name="heart" size={20} color="#E0245E" style={styles.icon} />
    )}
    {notification.type === "retweet" && (
      <Ionicons name="repeat" size={20} color="#17BF63" style={styles.icon} />
    )}
  </View>
);

export default function NotificationsScreen() {
  return (
    <View style={styles.container}>
      <FlatList
        data={notifications}
        renderItem={({ item }) => <NotificationItem notification={item} />}
        keyExtractor={(item) => item.id}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#fff",
  },
  notificationContainer: {
    flexDirection: "row",
    padding: 15,
    borderBottomWidth: 1,
    borderBottomColor: "#e1e8ed",
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
