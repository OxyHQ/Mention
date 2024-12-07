import React from "react";
import { View, StyleSheet, TouchableOpacity } from "react-native";
import { Link } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { ThemedText } from "./ThemedText";

export function Sidebar() {
  return (
    <View style={styles.container}>
      <NavItem icon="home-outline" label="Home" href="/" />
      <NavItem icon="search-outline" label="Explore" href="/search" />
      <NavItem
        icon="notifications-outline"
        label="Notifications"
        href="/notifications"
      />
      <NavItem icon="mail-outline" label="Messages" href="/messages" />
      <NavItem icon="person-outline" label="Profile" href="/@johndoe" />
    </View>
  );
}

function NavItem({
  icon,
  label,
  href,
}: {
  icon: string;
  label: string;
  href: string;
}) {
  return (
    <Link href={href as any} asChild>
      <TouchableOpacity style={styles.navItem}>
        <Ionicons name={icon as any} size={24} color="#000" />
        <ThemedText style={styles.navLabel}>{label}</ThemedText>
      </TouchableOpacity>
    </Link>
  );
}

const styles = StyleSheet.create({
  container: {
    padding: 16,
  },
  navItem: {
    flexDirection: "row",
    alignItems: "center",
    padding: 12,
    borderRadius: 9999,
    marginVertical: 4,
  },
  navLabel: {
    marginLeft: 16,
    fontSize: 20,
  },
});
