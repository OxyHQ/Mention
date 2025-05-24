import React, { useEffect, useRef } from 'react';
import { View, StyleSheet, Animated, Easing } from 'react-native';

interface AnimatedSkeletonProps {
    width?: number | string;
    height?: number | string;
    borderRadius?: number;
    marginBottom?: number;
}

const AnimatedSkeleton: React.FC<AnimatedSkeletonProps> = ({
    width = '100%',
    height = 20,
    borderRadius = 4,
    marginBottom = 10
}) => {
    const animatedValue = useRef(new Animated.Value(0)).current;

    useEffect(() => {
        Animated.loop(
            Animated.timing(animatedValue, {
                toValue: 1,
                duration: 1500,
                easing: Easing.ease,
                useNativeDriver: false
            })
        ).start();
    }, [animatedValue]);

    const interpolatedColor = animatedValue.interpolate({
        inputRange: [0, 0.5, 1],
        outputRange: ['#EEEEEE', '#DDDDDD', '#EEEEEE']
    });

    return (
        <Animated.View
            style={{
                width,
                height,
                borderRadius,
                backgroundColor: interpolatedColor,
                marginBottom,
            }}
        />
    );
};

export default AnimatedSkeleton;