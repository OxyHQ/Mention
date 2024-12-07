import React from "react";
import { View, StyleSheet } from "react-native";

export function EllipsisWrapper({ children }: { children: React.ReactNode }) {
  return <View style={styles.ellipsis}>{children}</View>;
}

const styles = StyleSheet.create({
  ellipsis: {
    flex: 1,
    flexDirection: "row",
    overflow: "hidden",
  },
});
