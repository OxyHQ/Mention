import React from "react";
import { View, StyleSheet, Image, TouchableOpacity } from "react-native";
import { ThemedText } from "./ThemedText";
import { ThemedView } from "./ThemedView";
import { sampleTrends } from "@/constants/sampleData"; // Import sampleTrends

const trendingTopics = sampleTrends.map((trend, index) => ({
  id: (index + 1).toString(),
  topic: trend.hashtag,
  posts: trend.count.toString(),
}));

const suggestedUsers = [
  { id: "1", name: "John Doe", handle: "@johndoe", avatar: "path/to/avatar1.png" },
  { id: "2", name: "Jane Smith", handle: "@janesmith", avatar: "path/to/avatar2.png" },
  { id: "3", name: "Bob Johnson", handle: "@bobjohnson", avatar: "path/to/avatar3.png" },
  // Add more suggested users here
];

export function Widgets() {
  return (
    <View style={styles.container}>
      <ThemedView style={styles.widget}>
        <ThemedText type="title" style={styles.widgetTitle}>Who to follow</ThemedText>
        {suggestedUsers.map((user) => (
          <TouchableOpacity key={user.id} style={styles.userItem}>
            <Image source={{ uri: user.avatar }} style={styles.avatar} />
            <View style={styles.userInfo}>
              <ThemedText style={styles.userName}>{user.name}</ThemedText>
              <ThemedText style={styles.userHandle}>{user.handle}</ThemedText>
            </View>
            <TouchableOpacity style={styles.followButton}>
              <ThemedText style={styles.followButtonText}>Follow</ThemedText>
            </TouchableOpacity>
          </TouchableOpacity>
        ))}
      </ThemedView>

      <ThemedView style={styles.widget}>
        <ThemedText type="title" style={styles.widgetTitle}>Trending</ThemedText>
        {trendingTopics.map((topic) => (
          <View key={topic.id} style={styles.trendingItem}>
            <ThemedText style={styles.trendingTopic}>{topic.topic}</ThemedText>
            <ThemedText style={styles.trendingPosts}>
              {topic.posts} Posts
            </ThemedText>
          </View>
        ))}
      </ThemedView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    padding: 16,
    gap: 16,
    width: "100%",
    maxWidth: 350,
    borderLeftWidth: 1,
    borderLeftColor: "#EFF3F4",
  },
  widget: {
    padding: 16,
    borderRadius: 16,
    backgroundColor: "#f7f9f9",
  },
  widgetTitle: {
    fontSize: 18,
    fontWeight: "bold",
    marginBottom: 8,
  },
  userItem: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: 8,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: "#E1E8ED",
  },
  avatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    marginRight: 8,
  },
  userInfo: {
    flex: 1,
  },
  userName: {
    fontWeight: "bold",
  },
  userHandle: {
    color: "gray",
  },
  followButton: {
    paddingVertical: 4,
    paddingHorizontal: 12,
    borderRadius: 16,
    backgroundColor: "#1DA1F2",
  },
  followButtonText: {
    color: "white",
    fontWeight: "bold",
  },
  trendingItem: {
    marginTop: 8,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: "#E1E8ED",
  },
  trendingTopic: {
    fontWeight: "bold",
  },
  trendingPosts: {
    color: "gray",
  },
});
