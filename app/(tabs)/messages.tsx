import React from "react";
import { View, Text, StyleSheet, FlatList, Image } from "react-native";
import { ThemedView } from "@/components/ThemedView";
import { ThemedText } from "@/components/ThemedText";

const messages = [
  {
    id: "1",
    user: {
      name: "Jane Smith",
      avatar: "https://via.placeholder.com/50",
    },
    content: "Hey, how are you?",
    timestamp: "2h ago",
  },
  {
    id: "2",
    user: {
      name: "Bob Johnson",
      avatar: "https://via.placeholder.com/50",
    },
    content: "Let's catch up soon!",
    timestamp: "4h ago",
  },
  // Add more messages
];

type Message = {
  id: string;
  user: {
    name: string;
    avatar: string;
  };
  content: string;
  timestamp: string;
};

const MessageItem = ({ message }: { message: Message }) => (
  <View style={styles.messageContainer}>
    <Image source={{ uri: message.user.avatar }} style={styles.avatar} />
    <View style={styles.messageContent}>
      <ThemedText style={styles.userName}>{message.user.name}</ThemedText>
      <ThemedText style={styles.messageText}>{message.content}</ThemedText>
      <ThemedText style={styles.timestamp}>{message.timestamp}</ThemedText>
    </View>
  </View>
);

export default function MessagesScreen() {
  return (
    <ThemedView style={styles.container}>
      <ThemedView style={styles.header}>
        <ThemedText style={styles.headerTitle}>Messages</ThemedText>
      </ThemedView>
      <FlatList
        data={messages}
        renderItem={({ item }) => <MessageItem message={item} />}
        keyExtractor={(item) => item.id}
      />
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: "#e1e8ed",
  },
  headerTitle: {
    fontSize: 24,
    fontWeight: "bold",
  },
  messageContainer: {
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
  messageContent: {
    flex: 1,
  },
  userName: {
    fontWeight: "bold",
  },
  messageText: {
    fontSize: 16,
  },
  timestamp: {
    color: "gray",
    marginTop: 5,
  },
});
