import React from "react";
import { View, StyleSheet } from "react-native";
import { ThemedText } from "./ThemedText";
import { ThemedView } from "./ThemedView";

const trendingTopics = [
  { id: "1", topic: "#ReactNative", tweets: "120K" },
  { id: "2", topic: "#JavaScript", tweets: "80K" },
  { id: "3", topic: "#MobileDevelopment", tweets: "50K" },
  // Add more trending topics here
];

export function Widgets() {
  return (
    <View style={styles.container}>
      <ThemedView style={styles.widget}>
        <ThemedText type="title">Who to follow</ThemedText>
        {/* Add suggested users here */}
      </ThemedView>

      <ThemedView style={styles.widget}>
        <ThemedText type="title">Trending</ThemedText>
        {trendingTopics.map((topic) => (
          <View key={topic.id} style={styles.trendingItem}>
            <ThemedText style={styles.trendingTopic}>{topic.topic}</ThemedText>
            <ThemedText style={styles.trendingTweets}>
              {topic.tweets} Tweets
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
  },
  widget: {
    padding: 16,
    borderRadius: 16,
    backgroundColor: "#f7f9f9",
  },
  trendingItem: {
    marginTop: 8,
  },
  trendingTopic: {
    fontWeight: "bold",
  },
  trendingTweets: {
    color: "gray",
  },
});
