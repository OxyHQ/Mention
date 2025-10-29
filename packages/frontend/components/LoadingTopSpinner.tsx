import React, { useEffect } from "react";
import { View, StyleSheet, ImageStyle } from "react-native";
import Animated, { Easing, useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { Loading } from "@/assets/icons/loading-icon";
import { useTheme } from "@/hooks/useTheme";

interface AvatarProps {
    size?: number;
    iconSize?: number;
    style?: ImageStyle;
    showLoading?: boolean;
}

const LoadingTopSpinner: React.FC<AvatarProps> = ({ size = 40, iconSize = 25, style, showLoading = true }) => {
    const theme = useTheme();
    const targetHeight = Math.max(0, iconSize + size);

    // Reanimated shared values
    const height = useSharedValue(showLoading ? targetHeight : 0);
    const opacity = useSharedValue(showLoading ? 1 : 0);
    const translateY = useSharedValue(showLoading ? 0 : -targetHeight);

    useEffect(() => {
        height.value = withTiming(showLoading ? targetHeight : 0, { duration: 250, easing: Easing.out(Easing.cubic) });
        opacity.value = withTiming(showLoading ? 1 : 0, { duration: 250, easing: Easing.out(Easing.cubic) });
        translateY.value = withTiming(showLoading ? 0 : -targetHeight, { duration: 250, easing: Easing.out(Easing.cubic) });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [showLoading, targetHeight]);

    const containerAnimated = useAnimatedStyle(() => ({
        height: height.value,
    }));

    const innerAnimated = useAnimatedStyle(() => ({
        opacity: opacity.value,
        transform: [{ translateY: translateY.value }],
    }));

    const styles = StyleSheet.create({
        container: {
            width: '100%',
            position: 'relative',
            overflow: 'hidden',
        },
        loadingView: {
            width: '100%',
            alignItems: 'center',
            justifyContent: 'center',
            position: 'absolute',
            top: 0,
            left: 0,
        },
    });

    return (
        <Animated.View style={[styles.container, containerAnimated]}>
            <Animated.View style={[styles.loadingView, { height: targetHeight }, innerAnimated, style]}>
                <Loading size={iconSize} color={theme.colors.primary} />
            </Animated.View>
        </Animated.View>
    );
};

export default LoadingTopSpinner;
