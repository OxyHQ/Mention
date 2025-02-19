import React, { useState, useCallback, useEffect } from "react";
import { Pressable, StyleSheet, GestureResponderEvent } from "react-native";
import Animated, {
    useSharedValue,
    useAnimatedStyle,
    withSpring,
    withTiming,
    runOnJS,
} from "react-native-reanimated";
import { ThemedText } from "./ThemedText";
import { colors } from '../styles/colors';
import { useTranslation } from "react-i18next";
import { useDispatch, useSelector } from 'react-redux';
import { AppDispatch, RootState } from '@/store/store';
import { followUser, unfollowUser, checkFollowStatus } from '@/store/reducers/followReducer';

interface FollowButtonProps {
    userId: string;
}

export const FollowButton = React.memo(({ userId }: FollowButtonProps) => {
    const { t } = useTranslation();
    const dispatch = useDispatch<AppDispatch>();
    const isFollowing = useSelector((state: RootState) => state.follow.following[userId] || false);
    const scale = useSharedValue(1);
    const translateY = useSharedValue(0);
    const textOpacity = useSharedValue(1);

    useEffect(() => {
        if (userId) {
            dispatch(checkFollowStatus(userId));
        }
    }, [dispatch, userId]);

    const animatedStyle = useAnimatedStyle(() => ({
        transform: [
            { scale: scale.value },
            { translateY: translateY.value * 0.1 }
        ],
    }));

    const textAnimatedStyle = useAnimatedStyle(() => ({
        opacity: textOpacity.value,
        transform: [{ translateY: translateY.value }],
    }));

    const handlePressIn = useCallback(() => {
        scale.value = withSpring(0.95, { 
            damping: 12,
            stiffness: 200 
        });
    }, []);

    const handlePressOut = useCallback(() => {
        scale.value = withSpring(1, { 
            damping: 12,
            stiffness: 200 
        });
    }, []);

    const handlePress = useCallback(async (event: GestureResponderEvent) => {
        event.preventDefault();
        try {
            scale.value = withSpring(0.9, {
                damping: 10,
                stiffness: 200
            });
            
            textOpacity.value = withTiming(0, { duration: 100 }, () => {
                translateY.value = 20;
                runOnJS(async () => {
                    if (isFollowing) {
                        await dispatch(unfollowUser(userId)).unwrap();
                    } else {
                        await dispatch(followUser(userId)).unwrap();
                    }
                })();
                
                translateY.value = withTiming(0, { duration: 200 });
                textOpacity.value = withTiming(1, { duration: 200 });
                scale.value = withSpring(1, {
                    damping: 8,
                    stiffness: 200
                });
            });
        } catch (error) {
            console.error('Error toggling follow state:', error);
        }
    }, [dispatch, userId, isFollowing]);

    return (
        <Animated.View style={animatedStyle}>
            <Pressable
                style={[styles.followButton, isFollowing && styles.followingButton]}
                onPressIn={handlePressIn}
                onPressOut={handlePressOut}
                onPress={handlePress}
            >
                <Animated.View style={textAnimatedStyle}>
                    <ThemedText style={[styles.followButtonText, isFollowing && styles.followingButtonText]}>
                        {isFollowing ? t("Following") : t("Follow")}
                    </ThemedText>
                </Animated.View>
            </Pressable>
        </Animated.View>
    );
});

const styles = StyleSheet.create({
    followButton: {
        paddingVertical: 4,
        paddingHorizontal: 12,
        borderRadius: 20,
        backgroundColor: colors.primaryColor,
        overflow: "hidden",
    },
    followingButton: {
        backgroundColor: 'transparent',
        borderWidth: 2,
        borderColor: colors.primaryColor,
    },
    followButtonText: {
        color: "white",
        fontWeight: "bold",
        fontSize: 16,
    },
    followingButtonText: {
        color: colors.primaryColor,
    },
});
