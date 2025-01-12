import React, { useState } from "react";
import { TouchableOpacity, StyleSheet } from "react-native";
import Animated, { useSharedValue, useAnimatedStyle, withSpring, withTiming } from "react-native-reanimated";
import { ThemedText } from "./ThemedText";
import { colors } from '../styles/colors'

export function FollowButton() {
    const [isFollowing, setIsFollowing] = useState(false);
    const scale = useSharedValue(1);
    const translateY = useSharedValue(0);

    const animatedStyle = useAnimatedStyle(() => {
        return {
            transform: [{ scale: scale.value }],
        };
    });

    const textAnimatedStyle = useAnimatedStyle(() => {
        return {
            transform: [{ translateY: translateY.value }],
        };
    });

    const handlePressIn = () => {
        scale.value = withSpring(0.9, { stiffness: 200 });
    };

    const handlePressOut = () => {
        scale.value = withSpring(1, { stiffness: 200 });
        translateY.value = withTiming(-20, { duration: 200 }, () => {
            setIsFollowing(!isFollowing);
            translateY.value = 20;
            translateY.value = withTiming(0, { duration: 200 });
        });
    };

    return (
        <Animated.View style={animatedStyle}>
            <TouchableOpacity
                style={styles.followButton}
                onPressIn={handlePressIn}
                onPressOut={handlePressOut}
            >
                <Animated.View style={textAnimatedStyle}>
                    <ThemedText style={styles.followButtonText}>
                        {isFollowing ? "Following" : "Follow"}
                    </ThemedText>
                </Animated.View>
            </TouchableOpacity>
        </Animated.View>
    );
}

const styles = StyleSheet.create({
    followButton: {
        paddingVertical: 4,
        paddingHorizontal: 12,
        borderRadius: 16,
        backgroundColor: colors.primaryColor,
        overflow: "hidden",
    },
    followButtonText: {
        color: "white",
        fontWeight: "bold",
    },
});
