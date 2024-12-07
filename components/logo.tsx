import React from "react";
import { View, StyleSheet, TouchableOpacity } from "react-native";
import { Link } from "expo-router";
import { MentionLogo } from "@/assets/mention-logo";

export function Logo() {
  return (
    <View style={styles.container}>
      <Link href={`/`} aria-label="Mention">
        <View style={styles.svgContainer}>
          <MentionLogo />
        </View>
      </Link>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    borderRadius: 9999,
    padding: 12,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "transparent",
  },
  svgContainer: {
    height: 40, // Example size, replace with your variable
    width: 40, // Example size, replace with your variable
  },
});
