import { Stack, useLocalSearchParams } from "expo-router";
import React from "react";
import { View, StyleSheet } from "react-native";
import Post from "@/components/Post";
import { ThemedView } from "@/components/ThemedView";
import { samplePosts } from "@/constants/sampleData";

export default function PostDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const post = samplePosts.find((t) => t.id === id);

  return (
    <>
      <Stack.Screen options={{ title: "Post" }} />
      <ThemedView style={styles.container}>
        {post && <Post {...post} showActions={false} />}
      </ThemedView>
    </>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
});
