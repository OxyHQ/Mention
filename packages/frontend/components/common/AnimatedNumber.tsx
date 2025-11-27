import React from 'react';
import { Text, TextProps } from 'react-native';
import Animated, { useSharedValue, useAnimatedStyle, withTiming, interpolate, useAnimatedReaction, runOnJS } from 'react-native-reanimated';
import { formatCompactNumber } from '@/utils/formatNumber';

interface AnimatedNumberProps extends Omit<TextProps, 'children'> {
    value: number;
    duration?: number;
    format?: (n: number) => string;
}

const AnimatedNumber: React.FC<AnimatedNumberProps> = ({
    value,
    duration = 300,
    format,
    style,
    ...textProps
}) => {
    const [display, setDisplay] = React.useState<number>(value);
    const progress = useSharedValue(1);
    const counterValue = useSharedValue(value);
    const previousValue = React.useRef(value);

    // Function to update display value from the animation thread
    const updateDisplay = React.useCallback((val: number) => {
        setDisplay(Math.round(val));
    }, []);

    // Watch for changes in counterValue and update display
    useAnimatedReaction(
        () => counterValue.value,
        (current, previous) => {
            if (previous === null || current !== previous) {
                runOnJS(updateDisplay)(current);
            }
        },
        []
    );

    React.useEffect(() => {
        if (previousValue.current !== value) {
            const oldValue = previousValue.current;
            previousValue.current = value;

            // Start animation
            progress.value = 0;
            progress.value = withTiming(1, { duration });

            // Animate counter value smoothly
            counterValue.value = withTiming(value, { duration });
        }
    }, [value, duration, progress, counterValue]);

    const animStyle = useAnimatedStyle(() => {
        return {
            opacity: interpolate(progress.value, [0, 0.3, 1], [0.5, 0.8, 1]),
            transform: [
                {
                    scale: interpolate(progress.value, [0, 1], [0.9, 1]),
                },
                {
                    translateY: interpolate(progress.value, [0, 0.5, 1], [2, -1, 0]),
                },
            ],
        };
    });

    // Use Animated.Text for smoother updates
    const DisplayTag = Animated.createAnimatedComponent(Text);

    // Format number for display (e.g., 1.2K, 1.5M)
    const formatNumber = React.useCallback((n: number): string => {
        if (format) return format(n);
        return formatCompactNumber(n);
    }, [format]);

    return (
        <DisplayTag {...textProps} style={[style, animStyle]}>
            {formatNumber(display)}
        </DisplayTag>
    );
};

export default AnimatedNumber;
