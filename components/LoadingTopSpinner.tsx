import React, { useEffect, useRef } from "react";
import { View, Animated } from 'react-native';
import { StyleSheet, ImageStyle } from "react-native";
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

    useEffect(() => {
        Animated.timing(heightAnim, {
            toValue: showLoading ? iconSize : 0,
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
            height: iconSize + size,
            paddingVertical: heightAnim.interpolate({
                inputRange: [0, iconSize],
                outputRange: [0, iconSize / 2],
            }),
        },
    });

    return (
        <Animated.View style={[styles.LoadingView, style]}>
            <Loading size={iconSize} />
        </Animated.View>
    );
};

export default LoadingTopSpinner;