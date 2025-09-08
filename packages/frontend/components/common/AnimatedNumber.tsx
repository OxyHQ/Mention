import React from 'react';
import { Text, TextProps } from 'react-native';
import Animated, { useSharedValue, useAnimatedStyle, withTiming, interpolate } from 'react-native-reanimated';

interface AnimatedNumberProps extends Omit<TextProps, 'children'> {
    value: number;
    duration?: number;
    format?: (n: number) => string;
}

const AnimatedNumber: React.FC<AnimatedNumberProps> = ({
    value,
    duration = 180,
    format,
    style,
    ...textProps
}) => {
    const [display, setDisplay] = React.useState<number>(value);
    const progress = useSharedValue(1);

    React.useEffect(() => {
        // Update number and play a subtle pop animation
        setDisplay(value);
        progress.value = 0;
        progress.value = withTiming(1, { duration });
    }, [value, duration, progress]);

    const animStyle = useAnimatedStyle(() => {
        return {
            opacity: interpolate(progress.value, [0, 1], [0.6, 1]),
            transform: [
                {
                    scale: interpolate(progress.value, [0, 1], [0.95, 1]),
                },
            ],
        };
    });

    // Use Animated.Text for smoother updates
    const DisplayTag = Animated.createAnimatedComponent(Text);

    return (
        <DisplayTag {...textProps} style={[style, animStyle]}>
            {format ? format(display) : String(display)}
        </DisplayTag>
    );
};

export default AnimatedNumber;
