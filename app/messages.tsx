import React, { useState } from "react";
import { View, Text, StyleSheet, FlatList, Image, TouchableOpacity, TextInput, ScrollView } from "react-native";
import { Stack, useLocalSearchParams, router } from "expo-router";
import { ThemedView } from "@/components/ThemedView";
import { ThemedText } from "@/components/ThemedText";
import { useTranslation } from "react-i18next";
import { Ionicons } from "@expo/vector-icons";

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

const stories = [
  {
    id: "1",
    user: {
      name: "Alice",
      avatar: "https://via.placeholder.com/50",
    },
  },
  {
    id: "2",
    user: {
      name: "Bob",
      avatar: "https://via.placeholder.com/50",
    },
  },
  // Add more stories
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
  <TouchableOpacity style={styles.messageContainer}>
    <Image source={{ uri: message.user.avatar }} style={styles.avatar} />
    <View style={styles.messageContent}>
      <View style={styles.messageHeader}>
        <ThemedText style={styles.userName}>{message.user.name}</ThemedText>
        <ThemedText style={styles.timestamp}>{message.timestamp}</ThemedText>
      </View>
      <ThemedText style={styles.messageText} numberOfLines={1}>{message.content}</ThemedText>
    </View>
  </TouchableOpacity>
);

const StoryItem = ({ story }: { story: { id: string; user: { name: string; avatar: string } } }) => (
  <View style={styles.storyContainer}>
    <Image source={{ uri: story.user.avatar }} style={styles.storyAvatar} />
    <ThemedText style={styles.storyUserName}>{story.user.name}</ThemedText>
  </View>
);

const Header = () => (
  <View style={styles.header}>
    <TouchableOpacity onPress={() => router.back()}>
      <Ionicons name="arrow-back" size={30} color="black" />
    </TouchableOpacity>
    <ThemedText style={styles.headerTitle}>Chats</ThemedText>
    <TouchableOpacity onPress={() => { /* Add new chat functionality */ }}>
      <Ionicons name="create-outline" size={30} color="black" />
    </TouchableOpacity>
  </View>
);

export default function MessagesScreen() {
  const { t } = useTranslation();
  const [searchQuery, setSearchQuery] = useState("");

  const filteredMessages = messages.filter((message) =>
    message.user.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    message.content.toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <>
      <Stack.Screen options={{ title: `${t("Messages")}` }} />
      <ThemedView style={styles.container}>
        <Header />
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.storiesContainer}>
          {stories.map((story) => (
            <StoryItem key={story.id} story={story} />
          ))}
        </ScrollView>
        <TextInput
          style={styles.searchBar}
          placeholder={t("Search")}
          value={searchQuery}
          onChangeText={setSearchQuery}
        />
        <FlatList
          data={filteredMessages}
          renderItem={({ item }) => <MessageItem message={item} />}
          keyExtractor={(item) => item.id}
        />
      </ThemedView>
    </>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: "#fff",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    padding: 10,
    borderBottomWidth: 1,
    borderBottomColor: "#e1e8ed",
  },
  headerTitle: {
    fontSize: 20,
    fontWeight: "bold",
  },
  searchBar: {
    height: 40,
    borderColor: "#e1e8ed",
    borderWidth: 1,
    borderRadius: 20,
    paddingHorizontal: 15,
    margin: 10,
  },
  storiesContainer: {
    paddingVertical: 10,
    paddingHorizontal: 5,
    borderBottomWidth: 1,
    borderBottomColor: "#e1e8ed",
  },
  storyContainer: {
    alignItems: "center",
    marginHorizontal: 10,
  },
  storyAvatar: {
    width: 60,
    height: 60,
    borderRadius: 30,
    marginBottom: 5,
  },
  storyUserName: {
    fontSize: 12,
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
    justifyContent: "center",
  },
  messageHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
  },
  userName: {
    fontWeight: "bold",
    fontSize: 16,
  },
  messageText: {
    fontSize: 16,
    color: "#333",
  },
  timestamp: {
    color: "gray",
  },
});
