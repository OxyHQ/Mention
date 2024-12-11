import React from "react";
import { View, TouchableOpacity, StyleSheet, AccessibilityInfo } from "react-native";
import { Stack, Link } from "expo-router";

import { MentionLogo } from "@/assets/mention-logo";

export const Logo = () => {

    return (
        <Link href="/">
            <TouchableOpacity
                style={styles.container}
                accessibilityLabel="Mention"
                accessibilityRole="button"
            >
                <View style={styles.logo}>
                    <MentionLogo />
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
        padding: 12, // Equivalent to `0.75em`
    },
    logoSvg: {
        height: 48, // Replace with the appropriate `var(--logo-size)`
        width: 48, // Replace with the appropriate `var(--logo-size)`
    },
    // Add hover, active, and focus-visible styles using custom touch logic
});
