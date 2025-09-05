import React from 'react';
import Svg, { Rect } from 'react-native-svg';
import { ViewStyle } from 'react-native';
import { colors } from '@/styles/colors';
import Animated, { Easing, useAnimatedStyle, useSharedValue, withRepeat, withTiming } from 'react-native-reanimated';

export const Loading = ({ color = colors.primaryColor, size = 26, style: styleProp }: { color?: string; size?: number; style?: ViewStyle }) => {
    const rotation = useSharedValue(0);

    React.useEffect(() => {
        rotation.value = withRepeat(
            withTiming(360, { duration: 400, easing: Easing.linear }),
            -1,
            false
        );
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const animatedStyle = useAnimatedStyle(() => ({
        transform: [{ rotate: `${rotation.value}deg` }],
    }));

    return (
        <Animated.View
            style={[
                {
                    width: size,
                    height: size,
                    alignItems: 'center',
                    justifyContent: 'center',
                },
                animatedStyle,
                styleProp,
            ]}
        >
            <Svg viewBox="0 0 100 100" width={size} height={size}>
                <Rect fill={color} height="10" opacity="0" rx="5" ry="5" transform="rotate(-90 50 50)" width="28" x="67" y="45" />
                <Rect fill={color} height="10" opacity="0.125" rx="5" ry="5" transform="rotate(-45 50 50)" width="28" x="67" y="45" />
                <Rect fill={color} height="10" opacity="0.25" rx="5" ry="5" transform="rotate(0 50 50)" width="28" x="67" y="45" />
                <Rect fill={color} height="10" opacity="0.375" rx="5" ry="5" transform="rotate(45 50 50)" width="28" x="67" y="45" />
                <Rect fill={color} height="10" opacity="0.5" rx="5" ry="5" transform="rotate(90 50 50)" width="28" x="67" y="45" />
                <Rect fill={color} height="10" opacity="0.625" rx="5" ry="5" transform="rotate(135 50 50)" width="28" x="67" y="45" />
                <Rect fill={color} height="10" opacity="0.75" rx="5" ry="5" transform="rotate(180 50 50)" width="28" x="67" y="45" />
                <Rect fill={color} height="10" opacity="0.875" rx="5" ry="5" transform="rotate(225 50 50)" width="28" x="67" y="45" />
            </Svg>
        </Animated.View>
    );
};
