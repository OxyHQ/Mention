import React, { useEffect, useRef } from "react";
import { View, Animated } from 'react-native';
import { StyleSheet, ImageStyle } from "react-native";
import { colors } from "../styles/colors";
import { Loading } from "@/assets/icons/loading-icon";

interface AvatarProps {
    size?: number;
    style?: ImageStyle;
    showLoading?: boolean;
}

const LoadingTopSpinner: React.FC<AvatarProps> = ({ size = 40, style, showLoading }) => {
    const heightAnim = useRef(new Animated.Value(0)).current;

    useEffect(() => {
        Animated.timing(heightAnim, {
            toValue: showLoading ? size : 0,
            duration: 300,
            useNativeDriver: false,
        }).start();
    }, [showLoading]);

    const styles = StyleSheet.create({
        LoadingView: {
            width: '100%',
            alignItems: 'center',
            justifyContent: 'center',
            overflow: 'hidden',
            paddingVertical: heightAnim.interpolate({
                inputRange: [0, size],
                outputRange: [0, size / 2],
            }),
        },
    });

    return (
        <Animated.View style={[styles.LoadingView, style]}>
            <Loading size={size} />
        </Animated.View>
    );
};

export default LoadingTopSpinner;