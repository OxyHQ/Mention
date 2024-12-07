import { Stack, useLocalSearchParams } from "expo-router";
import React from "react";
import { View, StyleSheet } from "react-native";
import Tweet from "@/components/Tweet";
import { ThemedView } from "@/components/ThemedView";
import { sampleTweets } from "@/constants/sampleData";

export default function TweetDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const tweet = sampleTweets.find((t) => t.id === id);

  return (
    <>
      <Stack.Screen options={{ title: "Tweet" }} />
      <ThemedView style={styles.container}>
        {tweet && <Tweet {...tweet} showActions={false} />}
      </ThemedView>
    </>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
});
