import React, { useEffect, useRef } from "react";
import { View, Animated, StyleSheet, ImageStyle } from "react-native";
import { colors } from "../styles/colors";
import { Loading } from "@/assets/icons/loading-icon";

interface AvatarProps {
    size?: number;
    iconSize?: number;
    style?: ImageStyle;
    showLoading?: boolean;
}

const LoadingTopSpinner: React.FC<AvatarProps> = ({ size = 40, iconSize = 25, style, showLoading }) => {
    const heightAnim = useRef(new Animated.Value(0)).current;
    const opacityAnim = useRef(new Animated.Value(0)).current;

    useEffect(() => {
        // Use opacity for native driver animation
        Animated.timing(opacityAnim, {
            toValue: showLoading ? 1 : 0,
            duration: 300,
            useNativeDriver: true,
        }).start();

        // Use height without native driver since layout properties can't use it
        Animated.timing(heightAnim, {
            toValue: showLoading ? iconSize + size : 0,
            duration: 300,
            useNativeDriver: false,
        }).start();
    }, [showLoading, size, iconSize]);

    const styles = StyleSheet.create({
        loadingView: {
            width: '100%',
            alignItems: 'center',
            justifyContent: 'center',
            overflow: 'hidden',
            height: heightAnim as any,
            paddingVertical: heightAnim.interpolate({
                inputRange: [0, iconSize],
                outputRange: [0, iconSize / 2],
            }),
        },
    });

    return (
        <Animated.View style={[styles.loadingView, { opacity: opacityAnim }, style]}>
            <Loading size={iconSize} />
        </Animated.View>
    );
};

export default LoadingTopSpinner;