import React from "react";
import { View, StyleSheet, Image, TouchableOpacity } from "react-native";
import { ThemedText } from "./ThemedText";
import { ThemedView } from "./ThemedView";
import { Trends } from "@/features/trends/Trends";
import { FollowButton } from "@/components/FollowButton";

const suggestedUsers = [
  { id: "1", name: "John Doe", handle: "@johndoe", avatar: "" },
  { id: "2", name: "Jane Smith", handle: "@janesmith", avatar: "" },
  { id: "3", name: "Bob Johnson", handle: "@bobjohnson", avatar: "" },
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
            <FollowButton />
          </TouchableOpacity>
        ))}
      </ThemedView>

      <ThemedView style={styles.widget}>
        <ThemedText type="title" style={styles.widgetTitle}>Trending</ThemedText>
        <Trends />
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
