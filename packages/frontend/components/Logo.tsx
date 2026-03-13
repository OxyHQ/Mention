import React from "react";
import { View, TouchableOpacity, StyleSheet, AccessibilityInfo, Pressable, Platform } from "react-native";
import { Stack, Link, useRouter } from "expo-router";

import { LogoIcon } from "@/assets/logo";

export const Logo = () => {
  const router = useRouter();

  return (
    <Pressable
      onPress={() => router.push("/")}
      className="active:bg-primary/20"
      style={styles.container}>
      <View style={styles.logo}>
        <LogoIcon style={styles.logoSvg} size={27}
          className="text-foreground" />
      </View>
    </Pressable>
  );
};

const styles = StyleSheet.create({
  container: {
    justifyContent: "center",
    alignItems: "center",
    width: 'auto',
    marginBottom: 10,
    borderRadius: 1000,
    ...Platform.select({
      web: {
        cursor: 'pointer',
      },
    }),
  },
  logo: {
    padding: 10,
  },
  logoSvg: {
  },
});
