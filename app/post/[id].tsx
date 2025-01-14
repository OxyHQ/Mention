import { Stack, useLocalSearchParams } from "expo-router";
import React from "react";
import { View, StyleSheet } from "react-native";
import Post from "@/components/Post";
import { Header } from "@/components/Header";

export default function PostDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();

  return (
    <>
      <Header options={{ title: `Post by ${"HElo" || "user"}` }} />

    </>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#fff",
  },
});
