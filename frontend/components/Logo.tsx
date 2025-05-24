import React from "react";
import { View, TouchableOpacity, StyleSheet, AccessibilityInfo, Pressable, Platform } from "react-native";
import { Stack, Link, useRouter } from "expo-router";

import { LogoIcon } from "@/assets/logo";
import { colors } from '@/styles/colors'

export const Logo = () => {
  const router = useRouter();

  return (
    <Pressable
      onPress={() => router.push("/")}
      style={({ pressed }) => [
        pressed ? { backgroundColor: `${colors.primaryColor}33`, } : {},
        styles.container,
      ]}>
      <View style={styles.logo}>
        <LogoIcon style={styles.logoSvg} size={27}
          color={colors.primaryColor} />
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
