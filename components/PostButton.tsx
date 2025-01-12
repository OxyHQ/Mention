import React from "react";
import { TouchableOpacity, StyleSheet } from "react-native";
import { Link } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { ThemedText } from "./ThemedText";

export function PostButton() {
  return (
    <Link href="/compose" asChild>
      <TouchableOpacity style={styles.composeButton}>
        <Ionicons name="create-outline" size={24} color="#FFFFFF" />
        <ThemedText style={styles.composeLabel}>Compose</ThemedText>
      </TouchableOpacity>
    </Link>
  );
}

const styles = StyleSheet.create({
  composeButton: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#1DA1F2",
    padding: 12,
    borderRadius: 999,
    marginVertical: 12,
  },
  composeLabel: {
    marginLeft: 16,
    fontSize: 20,
    color: "#FFFFFF",
    fontWeight: "bold",
  },
});
