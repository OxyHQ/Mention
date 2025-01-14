import { Stack, useLocalSearchParams } from "expo-router";
import React from "react";
import { View, StyleSheet } from "react-native";
import Post from "@/components/Post";
import { Header } from "@/components/Header";
import { useFetchPost } from '@/hooks/useFetchPost';

export default function PostDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const post = useFetchPost(id);

  return (
    <>
      <Header options={{ title: `Post by ${post?.author.username || "user"}` }} />
      {post && (
        <Post postData={post} />
      )}
    </>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#fff",
  },
});
