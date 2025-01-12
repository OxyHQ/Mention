import React from "react";
import { View, TouchableOpacity, StyleSheet, AccessibilityInfo } from "react-native";
import { Stack, Link } from "expo-router";

import { MentionLogo } from "@/assets/mention-logo";
import { colors } from '@/styles/colors'

export const Logo = () => {

  return (
    <Link href="/">
      <TouchableOpacity
        style={styles.container}
        accessibilityLabel="Mention"
        accessibilityRole="button"
      >
        <View style={styles.logo}>
          <MentionLogo style={styles.logoSvg} size={27}
            color={colors.primaryColor} />
        </View>
      </TouchableOpacity>
    </Link>
  );
};

const styles = StyleSheet.create({
  container: {
    borderRadius: 1000, // Simulates `100vmax`
    cursor: "pointer",
    justifyContent: "center",
    alignItems: "center",
  },
  logo: {
  },
  logoSvg: {
    padding: 10,
  },
  // Add hover, active, and focus-visible styles using custom touch logic
});
