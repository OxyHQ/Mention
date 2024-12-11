import React from "react";
import { Text, StyleSheet } from "react-native";
import { Link } from "expo-router";

export const detectHashtags = (text: string) => {
  const parts = text.split(/(#[a-zA-Z0-9_]+)/g);
  return parts.map((part, index) =>
    part.startsWith("#") ? (
      <Link key={index} href={`/hashtag/${part.slice(1)}` as unknown as any}>
        <Text style={styles.hashtag}>{part}</Text>
      </Link>
    ) : (
      part
    )
  );
};

const styles = StyleSheet.create({
  hashtag: {
    color: 'blue',
    fontWeight: 'bold',
  },
});
