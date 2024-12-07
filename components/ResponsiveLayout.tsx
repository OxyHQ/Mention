import React from "react";
import { View, StyleSheet, useWindowDimensions, Platform } from "react-native";
import { ThemedView } from "./ThemedView";
import { ScrollView } from "react-native-gesture-handler";

interface ResponsiveLayoutProps {
  mainContent: React.ReactNode;
  sidebarContent?: React.ReactNode;
  widgetsContent?: React.ReactNode;
}

export function ResponsiveLayout({
  mainContent,
  sidebarContent,
  widgetsContent,
}: ResponsiveLayoutProps) {
  const { width } = useWindowDimensions();
  const isWeb = Platform.OS === "web";
  const showSidebar = isWeb && width >= 768;
  const showWidgets = isWeb && width >= 1024;

  if (!showSidebar) {
    return <ThemedView style={styles.container}>{mainContent}</ThemedView>;
  }

  return (
    <ThemedView style={styles.container}>
      {showSidebar && (
        <View style={styles.sidebar}>
          <ScrollView>{sidebarContent}</ScrollView>
        </View>
      )}
      <View style={styles.mainContentWrapper}>{mainContent}</View>
      {showWidgets && (
        <View style={styles.widgets}>
          <ScrollView>{widgetsContent}</ScrollView>
        </View>
      )}
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    flexDirection: "row",
  },
  sidebar: {
    width: 275,
    borderRightWidth: 1,
    borderRightColor: "#EFF3F4",
  },
  mainContentWrapper: {
    flex: 1,
    alignItems: "center",
    width: "100%",
    maxWidth: 600,
  },
  widgets: {
    width: 290,
    borderLeftWidth: 1,
    borderLeftColor: "#EFF3F4",
  },
});
