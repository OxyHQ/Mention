import React, { useState } from "react";
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
  const { width, height } = useWindowDimensions();
  const isWeb = Platform.OS === "web";
  const showSidebar = isWeb && width >= 768;
  const showWidgets = isWeb && width >= 1024;
  const isLandscape = width > height;

  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [widgetsCollapsed, setWidgetsCollapsed] = useState(false);

  const handleSidebarToggle = () => setSidebarCollapsed(!sidebarCollapsed);
  const handleWidgetsToggle = () => setWidgetsCollapsed(!widgetsCollapsed);

  const sidebarWidth = isLandscape ? 300 : 275;
  const widgetsWidth = isLandscape ? 320 : 290;

  if (!showSidebar) {
    return <ThemedView style={styles.container}>{mainContent}</ThemedView>;
  }

  return (
    <ThemedView style={styles.container}>
      {showSidebar && (
        <View style={[styles.sidebar, { width: sidebarCollapsed ? 0 : sidebarWidth }]}>
          <ScrollView>{sidebarContent}</ScrollView>
        </View>
      )}
      <View style={styles.mainContentWrapper}>
        <View style={styles.mainContent}>{mainContent}</View>
      </View>
      {showWidgets && (
        <View style={[styles.widgets, { width: widgetsCollapsed ? 0 : widgetsWidth }]}>
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
    borderRightWidth: 1,
    borderRightColor: "#EFF3F4",
  },
  mainContentWrapper: {
    flex: 1,
    alignItems: "center",
  },
  mainContent: {
    width: "100%",
    maxWidth: 600,
    flex: 1,
  },
  widgets: {
    borderLeftWidth: 1,
    borderLeftColor: "#EFF3F4",
  },
});
