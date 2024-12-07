import React from "react";
import { View, StyleSheet } from "react-native";
import { ThemedText } from "./ThemedText";
import { ThemedView } from "./ThemedView";

export function Widgets() {
  return (
    <View style={styles.container}>
      <ThemedView style={styles.widget}>
        <ThemedText type="title">Who to follow</ThemedText>
        {/* Add suggested users here */}
      </ThemedView>

      <ThemedView style={styles.widget}>
        <ThemedText type="title">Trending</ThemedText>
        {/* Add trending topics here */}
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
});
