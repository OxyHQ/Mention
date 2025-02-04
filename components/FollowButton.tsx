import React, { useState, useCallback } from "react";
import { Pressable, StyleSheet } from "react-native";
import Animated, {
    useSharedValue,
    useAnimatedStyle,
    withSpring,
    withTiming,
    runOnJS,
} from "react-native-reanimated";
import { ThemedText } from "./ThemedText";
import { colors } from '../styles/colors';
import { Link } from 'expo-router';
import { useTranslation } from "react-i18next";

export const FollowButton = React.memo(() => {
    const { t } = useTranslation();
    const [isFollowing, setIsFollowing] = useState(false);
    const scale = useSharedValue(1);
    const translateY = useSharedValue(0);

    const animatedStyle = useAnimatedStyle(() => ({
        transform: [{ scale: scale.value }],
    }));

    const textAnimatedStyle = useAnimatedStyle(() => ({
        transform: [{ translateY: translateY.value }],
    }));

    const handlePressIn = useCallback(() => {
        scale.value = withSpring(0.9, { stiffness: 200 });
    }, []);

    const handlePressOut = useCallback(() => {
        scale.value = withSpring(1, { stiffness: 200 });
        translateY.value = withTiming(-20, { duration: 200 }, () => {
            runOnJS(setIsFollowing)((prev) => !prev);
            translateY.value = 20;
            translateY.value = withTiming(0, { duration: 200 });
        });
    }, []);

    const handlePress = useCallback((event) => {
        event.preventDefault();
        // Add any additional logic here if needed
    }, []);

    return (
        <Animated.View style={animatedStyle}>
            <Pressable
                style={styles.followButton}
                onPressIn={handlePressIn}
                onPressOut={handlePressOut}
                onPress={handlePress}
            >
                <Animated.View style={textAnimatedStyle}>
                    <ThemedText style={styles.followButtonText}>
                        {isFollowing ? t("Following") : t("Follow")}
                    </ThemedText>
                </Animated.View>
            </Pressable>
        </Animated.View>
    );
});

const styles = StyleSheet.create({
    followButton: {
        paddingVertical: 8,
        paddingHorizontal: 16,
        borderRadius: 20,
        backgroundColor: colors.primaryColor,
        overflow: "hidden",
    },
    followButtonText: {
        color: "white",
        fontWeight: "bold",
        fontSize: 16,
    },
});
