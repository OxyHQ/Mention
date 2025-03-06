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
    const translateYAnim = useRef(new Animated.Value(0)).current;
    const opacityAnim = useRef(new Animated.Value(0)).current;
    const containerHeight = iconSize + size;

    useEffect(() => {
        Animated.parallel([
            Animated.timing(opacityAnim, {
                toValue: showLoading ? 1 : 0,
                duration: 300,
                useNativeDriver: true,
            }),
            Animated.timing(translateYAnim, {
                toValue: showLoading ? 0 : -containerHeight,
                duration: 300,
                useNativeDriver: true,
            })
        ]).start();
    }, [showLoading, size, iconSize, containerHeight]);

    const styles = StyleSheet.create({
        container: {
            width: '100%',
            height: containerHeight,
            position: 'relative',
            overflow: 'hidden',
        },
        loadingView: {
            width: '100%',
            height: containerHeight,
            alignItems: 'center',
            justifyContent: 'center',
            position: 'absolute',
            top: 0,
            left: 0,
        },
    });

    return (
        <View style={styles.container}>
            <Animated.View 
                style={[
                    styles.loadingView, 
                    { 
                        opacity: opacityAnim,
                        transform: [{ translateY: translateYAnim }]
                    },
                    style
                ]}
            >
                <Loading size={iconSize} />
            </Animated.View>
        </View>
    );
};

export default LoadingTopSpinner;